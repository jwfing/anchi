import { describe, expect, it } from 'vitest';
import { resolvedAgentSchema } from '@anchi/core';
import { teamRunSchema, executionSchema } from '@anchi/protocol';
import { validateTeamTool } from '../src/team.ts';

const origin = {
  coordinator: 'a'.repeat(32),
  task: 't-0123456789',
  agent: 'lead',
  chain: ['you', '@lead (t-0123456789)'],
};

describe('cross-server boundaries', () => {
  it('accepts only a saved node name and a plain worker agent id', () => {
    expect(executionSchema.safeParse({ server: 'cloud', agent: 'developer' }).success).toBe(true);
    for (const server of ['local', 'ssh:root@host', '-oProxyCommand=sh', '../cloud']) {
      expect(executionSchema.safeParse({ server, agent: 'developer' }).success).toBe(false);
    }
    expect(executionSchema.safeParse({ server: 'cloud', agent: '../builder' }).success).toBe(false);
  });

  it('refuses forged execution parameters and oversized origins', () => {
    const request = { origin, agent: 'developer', turn: 1, text: 'Review the change' };
    expect(teamRunSchema.safeParse(request).success).toBe(true);
    expect(teamRunSchema.safeParse({ ...request, connectors: ['github'] }).success).toBe(false);
    expect(teamRunSchema.safeParse({ ...request, agent: 'builder' }).success).toBe(false);
    expect(teamRunSchema.safeParse({ ...request, turn: 0 }).success).toBe(false);
    expect(
      teamRunSchema.safeParse({ ...request, origin: { ...origin, chain: Array(20).fill('x') } })
        .success,
    ).toBe(false);
  });

  it('does not relay administration, spoofed identity, or an ungranted delegate', () => {
    const agent = {
      ...resolvedAgentSchema.parse({
        id: 'worker',
        name: 'Worker',
        runtime: 'codex',
        delegates: ['reviewer'],
        prompt: {},
      }),
      sourceFiles: [],
    };
    expect(() => validateTeamTool(agent, 'approvals.decide', { allow: true })).toThrow();
    expect(() =>
      validateTeamTool(agent, 'anchi_delegate_task', { agent: 'admin', task: 'publish' }),
    ).toThrow();
    expect(() =>
      validateTeamTool(agent, 'anchi_delegate_task', { agent: 'reviewer', task: 'review', origin }),
    ).toThrow();
    expect(() =>
      validateTeamTool(agent, 'anchi_delegate_task', { agent: 'reviewer', task: 'review' }),
    ).not.toThrow();
  });
});
