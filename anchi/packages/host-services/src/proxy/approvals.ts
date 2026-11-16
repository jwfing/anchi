import { randomBytes } from 'node:crypto';
import { ControlError, type ApprovalItem, type WatchEvent } from '../control/protocol.ts';

export const APPROVAL_TIMEOUT = 300;
export const APPROVALS_PENDING_MAX = 32;

/**
 * Writes held for the user. The daemon watches this queue over the control socket and
 * answers; an unanswered request is refused after `timeout` seconds. Each pending item
 * carries the timeout it was given. The lines match the Python proxy's, which the daemon
 * already reads.
 */
export class Approvals {
  readonly pending = new Map<string, { item: ApprovalItem; resolve: (allow: boolean) => void }>();
  private readonly watchers = new Set<(line: string) => void>();
  private readonly pings = new Map<(line: string) => void, NodeJS.Timeout>();

  constructor(public timeout = APPROVAL_TIMEOUT) {}

  broadcast(event: WatchEvent): void {
    const line = JSON.stringify(event);
    for (const write of this.watchers) write(line);
  }

  /** 'approved', 'denied' or 'timeout'. */
  ask(
    item: Omit<ApprovalItem, 'id' | 'created_at' | 'timeout'>,
  ): Promise<'approved' | 'denied' | 'timeout'> {
    if (this.pending.size >= APPROVALS_PENDING_MAX) return Promise.resolve('denied');
    const full: ApprovalItem = {
      ...item,
      id: randomBytes(8).toString('hex'),
      created_at: Date.now() / 1000,
      timeout: this.timeout,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish('timeout'), this.timeout * 1000);
      const finish = (outcome: 'approved' | 'denied' | 'timeout') => {
        clearTimeout(timer);
        this.pending.delete(full.id);
        this.broadcast({ type: 'resolved', id: full.id });
        resolve(outcome);
      };
      this.pending.set(full.id, {
        item: full,
        resolve: (allow) => finish(allow ? 'approved' : 'denied'),
      });
      this.broadcast({ type: 'pending', approval: full });
    });
  }

  decide(id: string, allow: boolean): { id: string; allowed: boolean } {
    const entry = this.pending.get(id);
    if (!entry) throw new ControlError('UNKNOWN_APPROVAL');
    entry.resolve(allow);
    return { id, allowed: allow };
  }

  /** Streams pending approvals and changes to `write` until the returned function is called. */
  watch(write: (line: string) => void): () => void {
    for (const { item } of this.pending.values())
      write(JSON.stringify({ type: 'pending', approval: item }));
    this.watchers.add(write);
    const ping = setInterval(() => write('{"type": "ping"}'), 15_000);
    ping.unref();
    this.pings.set(write, ping);
    return () => {
      this.watchers.delete(write);
      clearInterval(this.pings.get(write));
      this.pings.delete(write);
    };
  }
}
