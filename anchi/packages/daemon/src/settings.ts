import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import {
  type AgentLayer,
  agentFile,
  agentLayerSchema,
  listAgentIds,
  parseYamlAs,
  type AgentPatch,
  ConfigError,
  connectorSchema,
  type HomeLayout,
  idSchema,
  patchAgentYaml,
  resolveAgent,
  workspaceSchema,
} from '@anchi/core';
import type { AgentUpdate, Inventory, WorkspaceSetting } from '@anchi/protocol';
import { z } from 'zod';
import { lineDiff } from './builder.ts';
import { checkReferences } from './inventory.ts';

/** A settings patch from a client, checked against the agent schema's own field rules. */
const patchSchema = z.strictObject({
  skills: z.array(idSchema).max(50).optional(),
  connectors: z.array(connectorSchema).max(7).optional(),
  workspaces: z.array(workspaceSchema).max(10).optional(),
});

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

/** The settings the panel edits, from an agent or a proposal's layer. */
export function settingsOf(agent: Pick<AgentLayer, 'skills' | 'connectors' | 'workspaces'>) {
  return {
    skills: agent.skills ?? [],
    connectors: agent.connectors ?? [],
    workspaces: (agent.workspaces ?? []).map((w): WorkspaceSetting => ({
      path: w.path,
      mode: w.mode ?? 'ro',
      ...(w.name ? { name: w.name } : {}),
    })),
  };
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

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
    inventory: Pick<Inventory, 'skills' | 'connectors' | 'agents'>;
    workspaceRoot: string;
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
    const found = checkReferences(agent, opts.inventory, opts.workspaceRoot);
    errors.push(...found.errors);
    warnings.push(...found.warnings);
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
  opts: { inventory: Pick<Inventory, 'skills' | 'connectors' | 'agents'>; workspaceRoot: string },
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
