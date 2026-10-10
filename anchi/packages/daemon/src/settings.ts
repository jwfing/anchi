import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import {
  type AgentLayer,
  agentFile,
  agentLayerSchema,
  listAgentIds,
  parseYamlAs,
  type AgentPatch,
  BASE_IMAGE,
  ConfigError,
  connectorSchema,
  type HomeLayout,
  idSchema,
  patchAgentYaml,
  resolveAgent,
  type Trigger,
  workspaceSchema,
} from '@anchi/core';
import type { AgentSettings, AgentUpdate, WorkspaceSetting } from '@anchi/protocol';
import { z } from 'zod';
import { checkReferences, type ReferenceInventory } from './inventory.ts';

const field = agentLayerSchema.shape;

/** A settings patch from a client, checked against the agent schema's own field rules. */
const patchSchema = z.strictObject({
  name: field.name,
  description: field.description,
  runtime: field.runtime,
  // '' removes the key: the template's value, or the runtime default.
  model: field.model.unwrap().or(z.literal('')).optional(),
  effort: field.effort.unwrap().or(z.literal('')).optional(),
  prompt: z
    .strictObject({
      mode: z.enum(['replace', 'append']).optional(),
      text: z.string().max(100_000).optional(),
    })
    .optional(),
  skills: z.array(idSchema).max(50).optional(),
  connectors: z.array(connectorSchema).max(7).optional(),
  workspaces: z.array(workspaceSchema).max(10).optional(),
});

/** The fields a patch may change, for messages. */
export const PATCH_FIELDS = Object.keys(patchSchema.shape);

export function parsePatch(raw: unknown): AgentPatch {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid settings: ${z.prettifyError(parsed.error)}`);
  const { skills, connectors, workspaces } = parsed.data;
  const unique = (l?: string[]) => !l || new Set(l).size === l.length;
  if (!unique(skills) || !unique(connectors) || !unique(workspaces?.map((w) => w.path))) {
    throw new Error('invalid settings: an entry appears twice');
  }
  return parsed.data;
}

const EDITABLE = [
  'name',
  'description',
  'runtime',
  'model',
  'effort',
  'prompt',
  'skills',
  'connectors',
  'workspaces',
] as const;

/** One line per trigger, for display. */
function triggerLine(t: Trigger): string {
  if ('schedule' in t) return `schedule ${t.schedule}`;
  const p = t.poll;
  const what =
    p.type === 'github-issues' ? p.query : [p.team, p.label, p.state].filter(Boolean).join(' ');
  return `poll ${p.type}${what ? ` ${what}` : ''} every ${t.every ?? 5} min`;
}

/**
 * What the settings panel shows of an agent: `agent` as resolved (or a proposal's layer), `own`
 * the agent's own file and `templates` the layers it extends, to tell which values are inherited.
 */
export function settingsView(
  agent: AgentLayer,
  own: AgentLayer = agent,
  templates: AgentLayer[] = [],
): Pick<AgentSettings, 'current' | 'inherited' | 'fixed'> {
  const inherited = EDITABLE.filter(
    (k) => own[k] === undefined && templates.some((t) => t[k] !== undefined),
  );
  return {
    current: {
      name: agent.name ?? agent.id ?? '',
      description: agent.description ?? '',
      runtime: agent.runtime ?? 'codex',
      model: agent.model ?? '',
      effort: agent.effort ?? '',
      prompt: { mode: agent.prompt?.mode ?? 'append', text: agent.prompt?.text ?? '' },
      skills: agent.skills ?? [],
      connectors: agent.connectors ?? [],
      workspaces: (agent.workspaces ?? []).map((w): WorkspaceSetting => ({
        path: w.path,
        mode: w.mode ?? 'ro',
        ...(w.name ? { name: w.name } : {}),
      })),
    },
    inherited,
    fixed: {
      ...(own.extends ? { extends: own.extends } : {}),
      ...(own.prompt?.file ? { promptFile: own.prompt.file } : {}),
      image: agent.image ?? BASE_IMAGE,
      sandbox: agent.sandbox ?? 'cell',
      delegates: agent.delegates ?? [],
      triggers: (agent.triggers ?? []).map(triggerLine),
      approvals: { ...agent.approvals },
      egress: agent.egress ?? null,
      ...(agent.accounts && Object.keys(agent.accounts).length
        ? { accounts: { ...agent.accounts } as Record<string, string> }
        : {}),
    },
  };
}

/** The settings view of an agent's file, or of the file as it would be with `override`. */
export function agentSettingsView(layout: HomeLayout, id: string, override?: string) {
  const agent = resolveAgent(id, layout, override);
  const layers = agent.sourceFiles.map((f, i, all) =>
    parseYamlAs(
      i === all.length - 1 && override !== undefined ? override : readFileSync(f, 'utf8'),
      agentLayerSchema,
      f,
    ),
  );
  return settingsView(agent, layers.at(-1)!, layers.slice(0, -1));
}

/** Minimal line diff (LCS) in unified style, for the confirmation dialogs. */
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

export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The change a patch makes to an agent's file, checked as the whole agent (templates included)
 * and against what exists. With `apply`, the file is written only when it is still the one the
 * reviewed diff was made from (`base`) and nothing blocks.
 */
export function updateAgentFile(
  layout: HomeLayout,
  id: string,
  patch: AgentPatch,
  opts: {
    apply?: boolean;
    base?: string;
    /** Without it, only the agent schema is checked, not what it refers to. */
    inventory?: ReferenceInventory;
    workspaceRoot?: string;
  },
): AgentUpdate {
  const file = agentFile(layout, id);
  if (!existsSync(file)) throw new Error(`agent "${id}" has no file in ${layout.agentsDir}`);
  const text = readFileSync(file, 'utf8');
  const base = digest(text);
  const next = patchAgentYaml(text, patch);
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const agent = resolveAgent(id, layout, next);
    if (opts.inventory) {
      const found = checkReferences(agent, opts.inventory, opts.workspaceRoot ?? '');
      errors.push(...found.errors);
      warnings.push(...found.warnings);
    }
  } catch (err) {
    errors.push(err instanceof ConfigError ? err.message.trim() : String(err));
  }
  const result = { diff: lineDiff(text, next), errors, warnings, base, applied: false };
  if (!opts.apply) return result;
  if (opts.base !== base) throw new Error(`${file} changed since you reviewed it; review again`);
  if (errors.length) throw new Error(`cannot save: ${errors.join('; ')}`);
  if (next !== text) replaceFile(file, next);
  return { ...result, applied: true };
}

const HOST = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/**
 * Adds one exact host to an agent's egress list (a host its cells were refused), keeping the
 * rest of the file. An agent without a list reaches any public host already.
 */
export function allowEgressHost(
  layout: HomeLayout,
  id: string,
  host: string,
  opts: { inventory: ReferenceInventory; workspaceRoot: string },
): { egress: string[] } {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST.test(h) || h.length > 253) {
    throw new Error('give one host name, such as registry.npmjs.org; wildcards are not added here');
  }
  const egress = resolveAgent(id, layout).egress;
  if (!egress) throw new Error(`@${id} has no egress list: it reaches any public host already`);
  const covers = (p: string) => p === h || (p.startsWith('*.') && h.endsWith(p.slice(1)));
  if (egress.some(covers)) throw new Error(`${h} is already in @${id}'s egress list`);
  const next = [...egress, h];
  const preview = updateAgentFile(layout, id, { egress: next }, opts);
  updateAgentFile(layout, id, { egress: next }, { ...opts, apply: true, base: preview.base });
  return { egress: next };
}

/** Replaces a file's text atomically, keeping its mode. */
export function replaceFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
}

/** An agent's delegates as resolved, or as written when the agent does not load. */
function delegatesOf(layout: HomeLayout, id: string): string[] {
  try {
    return resolveAgent(id, layout).delegates;
  } catch {
    try {
      return (
        parseYamlAs(readFileSync(agentFile(layout, id), 'utf8'), agentLayerSchema).delegates ?? []
      );
    } catch {
      return [];
    }
  }
}

/** Agents that may delegate to `id`. */
export function delegatorsOf(layout: HomeLayout, id: string): string[] {
  return listAgentIds(layout).filter(
    (other) => other !== id && delegatesOf(layout, other).includes(id),
  );
}

/** Removes `id` from another agent's delegates, keeping the rest of its file. */
export function removeDelegate(layout: HomeLayout, other: string, id: string): void {
  const file = agentFile(layout, other);
  const next = patchAgentYaml(readFileSync(file, 'utf8'), {
    delegates: delegatesOf(layout, other).filter((d) => d !== id),
  });
  replaceFile(file, next);
}
