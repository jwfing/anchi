import { createHash } from 'node:crypto';
import type { ResolvedAgent, Trigger } from '@anchi/core';
import type { TriggerInfo } from '@anchi/protocol';
import { nextRun, parseCron } from './cron.ts';
import type { Guest } from './guest.ts';
import type { Store, TriggerState } from './store.ts';

export const TICK_MS = 30_000;

export interface TriggerHost {
  agents(): ResolvedAgent[];
  start(agentId: string, text: string, trigger: 'schedule' | 'poll'): { id: string };
}

/** Stable per agent and trigger definition: editing a trigger makes a new one. */
export function triggerKey(agentId: string, trigger: Trigger): string {
  return createHash('sha256')
    .update(`${agentId}\n${JSON.stringify(trigger)}`)
    .digest('hex')
    .slice(0, 16);
}

/** `{title}`, `{url}` and `{id}` of a polled item, which is upstream (untrusted) text. */
export function fill(template: string, item: { id: string; title: string; url: string }): string {
  return template.replace(/\{(title|url|id)\}/g, (_m, k: 'title' | 'url' | 'id') => item[k]);
}

/**
 * Starts tasks without the user. Schedules fire on their cron minute; a run missed while the
 * Mac slept fires once on wake. Polls ask the egress service for new items every few minutes;
 * the first poll only records what exists, and each item starts at most one task.
 */
export class TriggerRunner {
  private timer?: NodeJS.Timeout;
  private busy = new Set<string>();

  constructor(
    private host: TriggerHost,
    private store: Store,
    private guest: Guest,
    private log: (m: string) => void = () => {},
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  list(): TriggerInfo[] {
    return this.host.agents().flatMap((agent) =>
      agent.triggers.map((t) => {
        const s = this.store.triggerState(triggerKey(agent.id, t));
        return {
          agentId: agent.id,
          key: triggerKey(agent.id, t),
          kind: 'schedule' in t ? ('schedule' as const) : ('poll' as const),
          spec: 'schedule' in t ? t.schedule : `${t.poll.type} every ${t.every ?? 5} min`,
          nextRun: s?.nextRun ?? null,
          lastRun: s?.lastRun ?? null,
          lastResult: s?.lastResult ?? null,
        };
      }),
    );
  }

  async tick(now = Date.now()): Promise<void> {
    const work: Promise<void>[] = [];
    for (const agent of this.host.agents()) {
      for (const trigger of agent.triggers) {
        const key = triggerKey(agent.id, trigger);
        if (this.busy.has(key)) continue;
        this.busy.add(key);
        work.push(
          this.run(agent, trigger, key, now)
            .catch((err) => this.log(`trigger ${agent.id}/${key}: ${(err as Error).message}`))
            .finally(() => this.busy.delete(key)),
        );
      }
    }
    await Promise.all(work);
  }

  private async run(agent: ResolvedAgent, trigger: Trigger, key: string, now: number) {
    const state: TriggerState = this.store.triggerState(key) ?? {
      key,
      agentId: agent.id,
      nextRun: null,
      lastRun: null,
      lastResult: null,
      baseline: false,
    };
    if ('schedule' in trigger) {
      const cron = parseCron(trigger.schedule);
      if (state.nextRun === null) {
        state.nextRun = nextRun(cron, now);
      } else if (now >= state.nextRun) {
        const task = this.host.start(agent.id, trigger.text, 'schedule');
        state.lastRun = now;
        state.lastResult = `started ${task.id}`;
        state.nextRun = nextRun(cron, now);
      }
      return this.store.saveTriggerState(state);
    }
    if (state.nextRun !== null && now < state.nextRun) return;
    state.nextRun = now + (trigger.every ?? 5) * 60_000;
    try {
      const items = await this.guest.poll(trigger.poll.type, { ...trigger.poll });
      state.lastRun = now;
      if (!state.baseline) {
        for (const item of items) this.store.markSeen(key, item.id);
        state.baseline = true;
        state.lastResult = `watching; ${items.length} existing items ignored`;
      } else {
        const fresh = items.filter((i) => !this.store.seen(key, i.id)).reverse();
        for (const item of fresh) {
          // Mark first: a crash after this point loses a task rather than starting it twice.
          if (!this.store.markSeen(key, item.id)) continue;
          const task = this.host.start(agent.id, fill(trigger.text, item), 'poll');
          this.store.setSeenTask(key, item.id, task.id);
        }
        state.lastResult = fresh.length ? `started ${fresh.length} task(s)` : 'nothing new';
      }
    } catch (err) {
      state.lastResult = `error: ${(err as Error).message}`;
    }
    this.store.saveTriggerState(state);
  }
}
