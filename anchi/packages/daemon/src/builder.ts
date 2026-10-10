import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type AgentPatch,
  agentFile,
  agentLayerSchema,
  BASE_IMAGE,
  HIGH_RISK_IDS,
  ConfigError,
  type HomeLayout,
  imageFile,
  imageRecipeSchema,
  parseYamlAs,
  patchAgentYaml,
  type ResolvedAgent,
  resolvedAgentSchema,
} from '@anchi/core';
import type { BuilderProposal } from '@anchi/protocol';
import { parse as parseYaml } from 'yaml';
import { checkReferences, type ReferenceInventory } from './inventory.ts';
import { digest, lineDiff, PATCH_FIELDS, parsePatch, updateAgentFile } from './settings.ts';

export const BUILDER_ID = 'builder';

const SKILL = `You are the Anchi agent builder. You help the user design one agent at a time through
conversation, then propose its configuration. You cannot change any configuration yourself:
the user reviews your proposal in a confirmation dialog, and only then is it written.

An agent is a YAML file. Fields:
- name: display name; description: one line.
- runtime: codex or claude-code (required). Use claude-code when the user asks for Claude.
  The inventory lists both and whether each is connected; one that is not connected can still
  be proposed (the user connects it in Runtimes), but say so.
- model (optional; e.g. gpt-5.5 for codex, claude-opus-5-5 or claude-sonnet-5-5 for
  claude-code) and effort (low | medium | high | xhigh; codex only).
- prompt: { mode: append, text: | ... } — the agent's system instructions. Be specific about
  its job, how it should work, and what it must not do.
- connectors: any of github, aws, linear (credentials injected outside the agent's cell) and
  gmail, drive, notion, slack (served by trusted services). Never put tokens anywhere. Grant
  only what the job needs.
- accounts (optional): which signed-in Google account gmail or drive use, e.g.
  { gmail: work }; the inventory lists them. Without it, the account named default.
- skills: ids of installed skills the agent can use (optional), e.g. [code-review]. Each turn
  starts with an <anchi-inventory> block listing the runtimes and connectors (and whether
  they are connected), installed skills, directories under ~/AnchiWorkspaces, agents and images. Propose only
  what it lists; if something is missing, tell the user how to add it instead.
- triggers: start tasks without the user (optional): { schedule: '0 9 * * 1-5', text: ... }
  (cron, local time), or { poll: { type: linear-issues, team?, label?, state? } or
  { type: github-issues, query: 'repo:o/r is:issue is:open label:agent' }, text: ...,
  every?: minutes } where text may use {title}, {url} and {id}. Outside content then reaches
  the agent: tell the user, who may want approvals for its writes.
- delegates: ids of agents this agent may hand tasks to (optional).
- approvals: per connector, ask to hold every write for the user's approval (optional), e.g.
  { github: ask }. Without it, writes go straight through; high-risk operations (merging a pull
  request, pushing to main or master, deleting a branch or repository, AWS deletions, ...) wait
  for the user anyway. Add it only when the user wants to approve the agent's writes.
- highRisk: high-risk operations this agent does without approval (optional), by id, e.g.
  { disable: [github-merge] } for an agent whose job is merging pull requests. Ids:
  ${HIGH_RISK_IDS.join(', ')}. Only when the user asks for it.
- workspaces: directories of the user's Mac under ~/AnchiWorkspaces, e.g.
  [{ path: projects/webapp, mode: rw }] (mode ro by default; they appear at
  /home/agent/workspaces/<name>). Use rw only when the agent must change files there.
- egress: hosts the agent may reach besides its runtime and connectors, e.g.
  [registry.npmjs.org, '*.pypi.org']. Propose the smallest list the job needs; omit it only
  if the job needs the open web.
- image: id of an image recipe (or omit for the base image, which has git, gh, curl, jq,
  Codex and Claude Code on Debian 12).
- sandbox: cell (default).

An image recipe is a YAML file with:
- description
- packages: Debian 12 package names, e.g. [nodejs, npm, python3-pip]
- run: shell commands run as root at build time, e.g. installing the AWS CLI v2 from its
  official zip. Commands download through a proxy without credentials.

Ask clarifying questions when the job is unclear. When ready, end your reply with exactly one
agent block and, if the agent needs tools beyond the base image, one image block:

\`\`\`anchi-agent id=<agent-id>
<agent YAML>
\`\`\`

\`\`\`anchi-image id=<image-id>
<image recipe YAML>
\`\`\`

Ids use lowercase letters, digits and "-". Never use the id "${BUILDER_ID}". If the user asks
for changes to your proposal, send a complete new proposal.

To change an existing agent (listed under Agents in the inventory), prefer a patch with only
the fields to change; the rest of its file, comments included, stays as it is:

\`\`\`anchi-agent-patch id=<agent-id>
model: claude-sonnet-5-5
skills: [code-review, test]
\`\`\`

A patch may set name, description, runtime, model, effort, prompt ({ mode, text }), skills,
connectors and workspaces. Lists replace the whole list: repeat the entries to keep. An empty
model, effort or description ('') removes it. For any other field (triggers, approvals,
egress, delegates, image), send a complete anchi-agent block with the whole agent instead.
The inventory shows each agent's file when the user's message names its id; otherwise it
shows a summary, so ask the user to name the agent if you need to see its prompt.`;

/** The builder itself: a Codex agent with no connectors, in a base-image cell. */
export function builderAgent(): ResolvedAgent {
  const agent = resolvedAgentSchema.parse({
    id: BUILDER_ID,
    name: 'Agent builder',
    description: 'Designs agents and their images; proposals need your confirmation',
    runtime: 'codex',
    prompt: { mode: 'append', text: SKILL },
    connectors: [],
    image: BASE_IMAGE,
  });
  return { ...agent, sourceFiles: [] };
}

const BLOCK =
  /```anchi-(agent-patch|agent|image) id=([a-z0-9][a-z0-9-]{0,39})[ \t]*\n([\s\S]*?)\n```/g;

export interface ParsedBlocks {
  agent?: { id: string; yaml: string };
  /** Only the fields to change in an existing agent's file. */
  patch?: { id: string; yaml: string };
  image?: { id: string; yaml: string };
}

/** Finds proposal blocks in builder output. The last agent (or patch) and image block win. */
export function parseBlocks(text: string): ParsedBlocks {
  const out: ParsedBlocks = {};
  for (const m of text.matchAll(BLOCK)) {
    const block = { id: m[2]!, yaml: `${m[3]!.trimEnd()}\n` };
    if (m[1] === 'image') out.image = block;
    else {
      delete out.agent;
      delete out.patch;
      out[m[1] === 'agent' ? 'agent' : 'patch'] = block;
    }
  }
  return out;
}

export { lineDiff };

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const MAX_YAML = 100_000;

/** What proposals are checked against: installed skills, agents, connectors, directories. */
export interface ProposalRefs {
  inventory: ReferenceInventory;
  workspaceRoot: string;
}

/** Validates builder output against the schemas and what exists; nothing is written. */
export function makeProposal(
  layout: HomeLayout,
  blocks: ParsedBlocks,
  refs?: ProposalRefs,
): BuilderProposal | undefined {
  if (blocks.patch) {
    return makeUpdate(layout, blocks.patch.id, blocks.patch.yaml, refs, { image: blocks.image });
  }
  if (!blocks.agent) return undefined;
  const errors: string[] = [];
  const warnings: string[] = [];
  const { id, yaml } = blocks.agent;
  if (id === BUILDER_ID) errors.push(`"${BUILDER_ID}" is reserved`);
  if (yaml.length > MAX_YAML || (blocks.image?.yaml.length ?? 0) > MAX_YAML) {
    errors.push('proposal is too large');
  }
  try {
    const layer = parseYamlAs(yaml, agentLayerSchema);
    if (layer.extends) errors.push('builder proposals cannot use "extends"');
    if (layer.prompt?.file) errors.push('builder proposals must inline the prompt text');
    if (layer.id && layer.id !== id) errors.push(`id "${layer.id}" does not match "${id}"`);
    const resolved = resolvedAgentSchema.safeParse({
      ...layer,
      id,
      name: layer.name ?? id,
      prompt: layer.prompt ?? {},
    });
    if (!resolved.success) errors.push(resolved.error.issues.map((i) => i.message).join('; '));
    else if (refs) {
      const found = checkReferences(resolved.data, refs.inventory, refs.workspaceRoot);
      errors.push(...found.errors);
      warnings.push(...found.warnings);
    }
    const image = layer.image;
    if (
      image &&
      image !== BASE_IMAGE &&
      blocks.image?.id !== image &&
      !existsSync(imageFile(layout, image))
    ) {
      errors.push(`image "${image}" does not exist and is not part of this proposal`);
    }
    if (blocks.image && image !== blocks.image.id) {
      errors.push(`the image block "${blocks.image.id}" is not used by the agent`);
    }
  } catch (err) {
    errors.push(err instanceof ConfigError ? err.message.trim() : String(err));
  }
  if (blocks.image) {
    if (blocks.image.id === BASE_IMAGE) errors.push(`"${BASE_IMAGE}" is the built-in image`);
    try {
      parseYamlAs(blocks.image.yaml, imageRecipeSchema);
    } catch (err) {
      errors.push(err instanceof ConfigError ? err.message.trim() : String(err));
    }
  }
  const before = read(agentFile(layout, id));
  return {
    id: `p-${randomBytes(4).toString('hex')}`,
    agentId: id,
    kind: before ? 'replace' : 'create',
    agentYaml: yaml,
    imageYaml: blocks.image?.yaml ?? null,
    agentDiff: lineDiff(before, yaml),
    imageDiff: blocks.image
      ? lineDiff(read(imageFile(layout, blocks.image.id)), blocks.image.yaml)
      : '',
    errors,
    warnings,
  };
}

/** A patch in builder output: YAML whose `null` removes a field, as `''` does. */
function readPatch(id: string, yaml: string): AgentPatch {
  if (yaml.length > MAX_YAML) throw new Error('proposal is too large');
  let raw: unknown;
  try {
    raw = parseYaml(yaml) ?? {};
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the patch is not a mapping');
  const { id: named, ...fields } = raw as Record<string, unknown>;
  if (named !== undefined && named !== id) throw new Error(`id "${named}" does not match "${id}"`);
  for (const k of ['description', 'model', 'effort']) if (fields[k] === null) fields[k] = '';
  try {
    return parsePatch(fields);
  } catch (err) {
    throw new Error(
      `${(err as Error).message.trim()}\na patch changes only ${PATCH_FIELDS.join(', ')}; send a complete anchi-agent block to change other fields`,
    );
  }
}

/**
 * A patch to an existing agent's file, checked as the settings panel's changes are. `base` is
 * the file's digest when the proposal was first made: a file changed since then is refused.
 */
export function makeUpdate(
  layout: HomeLayout,
  id: string,
  patch: AgentPatch | string,
  refs?: ProposalRefs,
  opts: { image?: ParsedBlocks['image']; base?: string } = {},
): BuilderProposal {
  const errors: string[] = [];
  const warnings: string[] = [];
  const file = agentFile(layout, id);
  const text = read(file);
  const proposal: BuilderProposal = {
    id: `p-${randomBytes(4).toString('hex')}`,
    agentId: id,
    kind: 'update',
    agentYaml: text,
    imageYaml: null,
    agentDiff: '',
    imageDiff: '',
    errors,
    warnings,
    patch: {},
    base: opts.base ?? digest(text),
  };
  if (id === BUILDER_ID) errors.push(`"${BUILDER_ID}" is reserved`);
  else if (!existsSync(file)) {
    errors.push(`agent "${id}" does not exist; propose it with an anchi-agent block`);
  }
  if (opts.image) errors.push('a patch cannot add an image; send a complete anchi-agent block');
  if (errors.length) return proposal;
  try {
    const parsed = typeof patch === 'string' ? readPatch(id, patch) : patch;
    proposal.patch = parsed;
    proposal.agentYaml = patchAgentYaml(text, parsed);
    const update = updateAgentFile(layout, id, parsed, { ...refs });
    proposal.agentDiff = update.diff;
    errors.push(...update.errors);
    warnings.push(...update.warnings);
    if (!update.diff) errors.push('the patch changes nothing');
    if (update.base !== proposal.base) {
      errors.push(`@${id}'s file changed since this proposal; ask the builder again`);
    }
  } catch (err) {
    errors.push(err instanceof ConfigError ? err.message.trim() : (err as Error).message);
  }
  return proposal;
}

/** A revision's fields over the patch's; prompt fields merge one by one. */
function mergePatch(base: AgentPatch, over: AgentPatch): AgentPatch {
  const merged = { ...base, ...over };
  if (base.prompt && over.prompt) merged.prompt = { ...base.prompt, ...over.prompt };
  return merged;
}

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Holds proposals until the user confirms or discards them. Only `apply` writes files. */
export class Proposals {
  private items = new Map<string, { proposal: BuilderProposal; imageId?: string }>();

  constructor(
    private layout: HomeLayout,
    private refs?: () => ProposalRefs,
  ) {}

  add(blocks: ParsedBlocks): BuilderProposal | undefined {
    const proposal = makeProposal(this.layout, blocks, this.refs?.());
    if (!proposal) return undefined;
    this.items.set(proposal.id, { proposal, imageId: blocks.image?.id });
    return proposal;
  }

  get(id: string): BuilderProposal {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown proposal "${id}"`);
    return item.proposal;
  }

  discard(id: string): void {
    this.items.delete(id);
  }

  /** The proposal with a settings patch applied, checked again; it keeps its id. */
  revise(id: string, patch: AgentPatch): BuilderProposal {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown proposal "${id}"`);
    const { proposal: old } = item;
    if (old.kind === 'update') {
      // Still against the file as it was when the builder proposed the patch.
      const revised = makeUpdate(
        this.layout,
        old.agentId,
        mergePatch(parsePatch(old.patch ?? {}), patch),
        this.refs?.(),
        { base: old.base },
      );
      const proposal = { ...revised, id };
      this.items.set(id, { ...item, proposal });
      return proposal;
    }
    const yaml = patchAgentYaml(old.agentYaml, patch);
    const revised = makeProposal(
      this.layout,
      {
        agent: { id: item.proposal.agentId, yaml },
        image:
          item.imageId && item.proposal.imageYaml
            ? { id: item.imageId, yaml: item.proposal.imageYaml }
            : undefined,
      },
      this.refs?.(),
    )!;
    const proposal = { ...revised, id };
    this.items.set(id, { ...item, proposal });
    return proposal;
  }

  /** Writes the proposal; returns the image to prebuild, if any. */
  apply(id: string): { agentId: string; imageId?: string } {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown proposal "${id}"`);
    const { proposal } = item;
    if (proposal.kind === 'update') {
      const patch = parsePatch(proposal.patch ?? {});
      const fresh = makeUpdate(this.layout, proposal.agentId, patch, this.refs?.(), {
        base: proposal.base,
      });
      if (fresh.errors.length) throw new Error(`proposal is invalid: ${fresh.errors.join('; ')}`);
      try {
        updateAgentFile(this.layout, proposal.agentId, patch, {
          ...this.refs?.(),
          apply: true,
          base: proposal.base,
        });
      } catch (err) {
        if (!/changed since/.test((err as Error).message)) throw err;
        throw new Error(
          `@${proposal.agentId}'s file changed since this proposal; ask the builder again`,
        );
      }
      this.items.delete(id);
      return { agentId: proposal.agentId };
    }
    // Validate again against the files and what exists now.
    const fresh = makeProposal(
      this.layout,
      {
        agent: { id: item.proposal.agentId, yaml: item.proposal.agentYaml },
        image:
          item.imageId && item.proposal.imageYaml
            ? { id: item.imageId, yaml: item.proposal.imageYaml }
            : undefined,
      },
      this.refs?.(),
    )!;
    if (fresh.errors.length) throw new Error(`proposal is invalid: ${fresh.errors.join('; ')}`);
    if (item.imageId && item.proposal.imageYaml) {
      writeAtomic(imageFile(this.layout, item.imageId), item.proposal.imageYaml);
    }
    writeAtomic(agentFile(this.layout, item.proposal.agentId), item.proposal.agentYaml);
    this.items.delete(id);
    return { agentId: item.proposal.agentId, imageId: item.imageId };
  }
}
