import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  agentFile,
  agentLayerSchema,
  BASE_IMAGE,
  ConfigError,
  type HomeLayout,
  imageFile,
  imageRecipeSchema,
  parseYamlAs,
  type ResolvedAgent,
  resolvedAgentSchema,
} from '@anchi/core';
import type { BuilderProposal } from '@anchi/protocol';

export const BUILDER_ID = 'builder';

const SKILL = `You are the Anchi agent builder. You help the user design one agent at a time through
conversation, then propose its configuration. You cannot change any configuration yourself:
the user reviews your proposal in a confirmation dialog, and only then is it written.

An agent is a YAML file. Fields:
- name: display name; description: one line.
- runtime: codex or claude-code (required). Use claude-code when the user asks for Claude.
- model (optional; e.g. gpt-5.5 for codex, claude-opus-5-5 or claude-sonnet-5-5 for
  claude-code) and effort (low | medium | high | xhigh; codex only).
- prompt: { mode: append, text: | ... } — the agent's system instructions. Be specific about
  its job, how it should work, and what it must not do.
- connectors: any of github, aws, linear (credentials injected outside the agent's cell) and
  gmail, drive, notion, slack (served by trusted services). Never put tokens anywhere. Grant
  only what the job needs.
- delegates: ids of agents this agent may hand tasks to (optional).
- approvals: per connector, ask to hold its writes for the user's approval (optional), e.g.
  { github: ask }.
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
for changes, send a complete new proposal.`;

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

const BLOCK = /```anchi-(agent|image) id=([a-z0-9][a-z0-9-]{0,39})[ \t]*\n([\s\S]*?)\n```/g;

export interface ParsedBlocks {
  agent?: { id: string; yaml: string };
  image?: { id: string; yaml: string };
}

/** Finds proposal blocks in builder output. The last block of each kind wins. */
export function parseBlocks(text: string): ParsedBlocks {
  const out: ParsedBlocks = {};
  for (const m of text.matchAll(BLOCK)) {
    const block = { id: m[2]!, yaml: `${m[3]!.trimEnd()}\n` };
    if (m[1] === 'agent') out.agent = block;
    else out.image = block;
  }
  return out;
}

/** Minimal line diff (LCS) in unified style, for the confirmation dialog. */
export function lineDiff(before: string, after: string): string {
  if (before === after) return '';
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      lines.push(`+ ${b[j]}`);
      j++;
    } else {
      lines.push(`- ${a[i]}`);
      i++;
    }
  }
  return lines.join('\n');
}

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const MAX_YAML = 100_000;

/** Validates builder output against the schemas; returns a proposal with errors listed. */
export function makeProposal(
  layout: HomeLayout,
  blocks: ParsedBlocks,
): BuilderProposal | undefined {
  if (!blocks.agent) return undefined;
  const errors: string[] = [];
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
  return {
    id: `p-${randomBytes(4).toString('hex')}`,
    agentId: id,
    agentYaml: yaml,
    imageYaml: blocks.image?.yaml ?? null,
    agentDiff: lineDiff(read(agentFile(layout, id)), yaml),
    imageDiff: blocks.image
      ? lineDiff(read(imageFile(layout, blocks.image.id)), blocks.image.yaml)
      : '',
    errors,
  };
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

  constructor(private layout: HomeLayout) {}

  add(blocks: ParsedBlocks): BuilderProposal | undefined {
    const proposal = makeProposal(this.layout, blocks);
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

  /** Writes the proposal; returns the image to prebuild, if any. */
  apply(id: string): { agentId: string; imageId?: string } {
    const item = this.items.get(id);
    if (!item) throw new Error(`unknown proposal "${id}"`);
    // Validate again against the files as they are now.
    const fresh = makeProposal(this.layout, {
      agent: { id: item.proposal.agentId, yaml: item.proposal.agentYaml },
      image:
        item.imageId && item.proposal.imageYaml
          ? { id: item.imageId, yaml: item.proposal.imageYaml }
          : undefined,
    })!;
    if (fresh.errors.length) throw new Error(`proposal is invalid: ${fresh.errors.join('; ')}`);
    if (item.imageId && item.proposal.imageYaml) {
      writeAtomic(imageFile(this.layout, item.imageId), item.proposal.imageYaml);
    }
    writeAtomic(agentFile(this.layout, item.proposal.agentId), item.proposal.agentYaml);
    this.items.delete(id);
    return { agentId: item.proposal.agentId, imageId: item.imageId };
  }
}
