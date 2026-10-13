import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvedAgentSchema, type ResolvedAgent, type Trigger } from '@anchi/core';
import { describe, expect, it } from 'vitest';
import type { Guest } from '../src/guest.ts';
import { Store } from '../src/store.ts';
import { TriggerRunner } from '../src/triggers.ts';

const at = (h: number, m = 0, d = 7) => new Date(2026, 9, d, h, m).getTime();

function agentWith(triggers: Trigger[]): ResolvedAgent {
  const config = resolvedAgentSchema.parse({
    id: 'dev',
    name: 'dev',
    runtime: 'codex',
    prompt: { mode: 'append', text: '' },
  });
  return { ...config, triggers, sourceFiles: [] };
}

function runner(agent: ResolvedAgent, start: () => { id: string }) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'anchi-triggers-')), 'state.db'));
  const logs: string[] = [];
  const host = { agents: () => [agent], start };
  return { runner: new TriggerRunner(host, store, {} as Guest, (m) => logs.push(m)), logs };
}

describe('TriggerRunner', () => {
  it('records a failing start in the trigger state and waits for the next minute', async () => {
    const agent = agentWith([{ schedule: '0 9 * * *', text: 'daily summary' }]);
    let starts = 0;
    const { runner: r, logs } = runner(agent, () => {
      starts += 1;
      throw new Error('boom');
    });
    await r.tick(at(8));
    await r.tick(at(9));
    expect(starts).toBe(1);
    expect(r.list()[0]).toMatchObject({ lastResult: 'error: boom', nextRun: at(9, 0, 8) });
    // Not retried on the next tick: the failed run waits for the next scheduled minute.
    await r.tick(at(9) + 30_000);
    expect(starts).toBe(1);
    expect(logs).toEqual([]);
  });

  it('surfaces an invalid cron expression instead of throwing on every tick', async () => {
    // Load validation rejects this; a stale config that still reaches the runner must not loop.
    const agent = agentWith([{ schedule: '0 25 * * *', text: 'x' } as Trigger]);
    let starts = 0;
    const { runner: r, logs } = runner(agent, () => {
      starts += 1;
      return { id: 't1' };
    });
    await r.tick(at(8));
    expect(starts).toBe(0);
    expect(logs).toEqual([]);
    expect(r.list()[0]).toMatchObject({
      lastResult: 'error: cron field "25" is out of range 0-23',
      nextRun: null,
    });
  });
});
