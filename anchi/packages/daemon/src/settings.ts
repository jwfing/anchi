import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import {
  type AgentLayer,
  agentFile,
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
  if (next !== text) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, next, { mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
  }
  return { ...result, applied: true };
}
