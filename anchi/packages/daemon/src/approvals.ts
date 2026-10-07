import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Approval } from '@anchi/protocol';
import type { GuestTransport } from './guest.ts';

const ID = /^[0-9a-f]{16}$/;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * The egress proxy's queue of writes waiting for the user, mirrored on the host. A
 * long-running `anchi-cell approvals watch` streams the queue; decisions go back through
 * `anchi-cell approvals decide`. The stream is restarted when it ends (VM restart, proxy
 * restart), and the proxy refuses a write nobody answers.
 */
export class ApprovalWatcher extends EventEmitter<{
  changed: [Approval[]];
  added: [Approval];
  resolved: [{ approval: Approval; decided: boolean }];
}> {
  private pending = new Map<string, Approval>();
  private decided = new Set<string>();
  private child?: ReturnType<GuestTransport['spawn']>;
  private retry = RETRY_MIN_MS;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private transport: GuestTransport,
    private log: (m: string) => void = () => {},
  ) {
    super();
  }

  list(): Approval[] {
    return [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.child?.kill();
  }

  async decide(id: string, allow: boolean): Promise<void> {
    if (!ID.test(id) || !this.pending.has(id)) throw new Error('unknown or expired approval');
    this.decided.add(id);
    const r = await this.transport.exec([
      'anchi-cell',
      'approvals',
      'decide',
      id,
      allow ? 'allow' : 'deny',
    ]);
    if (r.code !== 0) throw new Error('the approval expired before it was decided');
  }

  private connect() {
    if (this.stopped) return;
    const child = this.transport.spawn(['anchi-cell', 'approvals', 'watch']);
    this.child = child;
    child.stdin.end();
    child.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.retry = RETRY_MIN_MS;
      this.onLine(line);
    });
    child.on('close', () => {
      // Whatever was pending is gone with the stream; the proxy times it out on its side.
      if (this.pending.size) {
        this.pending.clear();
        this.emit('changed', []);
      }
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.retry);
      this.timer.unref();
      this.retry = Math.min(this.retry * 2, RETRY_MAX_MS);
    });
  }

  private onLine(line: string) {
    let event: { type?: string; id?: unknown; approval?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return this.log('approvals: bad line from the proxy');
    }
    if (event.type === 'pending' && event.approval) {
      const a = parse(event.approval);
      if (!a) return;
      this.pending.set(a.id, a);
      this.emit('added', a);
      this.emit('changed', this.list());
    } else if (event.type === 'resolved' && typeof event.id === 'string') {
      const a = this.pending.get(event.id);
      if (!a) return;
      this.pending.delete(event.id);
      const decided = this.decided.delete(event.id);
      this.emit('resolved', { approval: a, decided });
      this.emit('changed', this.list());
    }
  }
}

/** Validates an approval from the proxy; string fields are bounded, everything is untrusted. */
function parse(v: Record<string, unknown>): Approval | undefined {
  const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
  if (typeof v.id !== 'string' || !ID.test(v.id)) return undefined;
  return {
    id: v.id,
    task: str(v.task, 40),
    agent: str(v.agent, 40),
    connector: str(v.connector, 20),
    operation: str(v.operation, 300),
    host: str(v.host, 200),
    summary: str(v.summary, 4000),
    createdAt: typeof v.created_at === 'number' ? v.created_at * 1000 : Date.now(),
    timeout: typeof v.timeout === 'number' ? v.timeout : 300,
  };
}
