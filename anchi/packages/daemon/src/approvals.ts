import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Approval } from '@anchi/protocol';
import type { Guest, GuestTransport } from './guest.ts';

const ID = /^[0-9a-f]{16}$/;

/** From the proxy; host and path come from the agent's request. */
export interface CredentialAlert {
  task: string;
  agent: string;
  method: string;
  host: string;
  path: string;
}
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/**
 * The egress proxy's queue of writes waiting for the user, mirrored on the host. A
 * long-running `anchi-cell approvals watch` streams the queue; decisions go back through
 * `anchi-cell approvals decide`. The stream is restarted when it ends (VM restart, proxy
 * restart), and the proxy refuses a write nobody answers. The same stream carries the proxy's
 * alerts that a cell sent a credential of its own.
 */
export class ApprovalWatcher extends EventEmitter<{
  changed: [Approval[]];
  added: [Approval];
  resolved: [{ approval: Approval; decided: boolean }];
  /** A cell sent a credential of its own (not a placeholder) to a host. */
  credential: [CredentialAlert];
}> {
  private pending = new Map<string, Approval>();
  /** Connector-service writes: decided through the policy service, with its digest. */
  private policy = new Map<string, { approval: Approval; digest: string; timer: NodeJS.Timeout }>();
  private decided = new Set<string>();
  private child?: ReturnType<GuestTransport['spawn']>;
  private retry = RETRY_MIN_MS;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private transport: GuestTransport,
    private log: (m: string) => void = () => {},
    /** The origin chain of a task, for the dialog. */
    private origin: (taskId: string) => string = () => '',
  ) {
    super();
  }

  list(): Approval[] {
    return [...this.pending.values(), ...[...this.policy.values()].map((p) => p.approval)].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  /**
   * A connector service answered APPROVAL_REQUIRED to a cell. The cell only names the id; the
   * policy service says what it is, and it must be pending for the agent's own connector.
   */
  async addPolicy(
    guest: Guest,
    task: { id: string; agentId: string },
    connector: string,
    id: string,
  ) {
    if (this.policy.has(id)) return;
    const g = await guest.policyShow(id);
    // The bridge names the agent: the policy principal is `<connector>:<agent>`.
    if (g.state !== 'PENDING' || g.principal !== `${connector}:${task.agentId}`) {
      throw new Error('no such pending approval');
    }
    const approval: Approval = {
      id,
      kind: 'policy',
      task: task.id,
      agent: task.agentId,
      connector,
      operation: String(g.action.operation ?? '').slice(0, 300),
      host: connector,
      summary: JSON.stringify(g.action.params ?? {}, null, 2).slice(0, 4000),
      createdAt: g.created * 1000,
      timeout: Math.max(0, Math.round(g.expires - g.created)),
      reason: `${connector} writes ask for approval`,
      origin: this.origin(task.id),
    };
    const timer = setTimeout(
      () => this.dropPolicy(id, false),
      Math.max(0, g.expires * 1000 - Date.now()),
    );
    timer.unref();
    this.policy.set(id, { approval, digest: g.digest, timer });
    this.emit('added', approval);
    this.emit('changed', this.list());
  }

  private dropPolicy(id: string, decided: boolean) {
    const p = this.policy.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.policy.delete(id);
    this.emit('resolved', { approval: p.approval, decided });
    this.emit('changed', this.list());
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

  async decide(id: string, allow: boolean, guest?: Guest): Promise<void> {
    const p = this.policy.get(id);
    if (p && guest) {
      await guest.policyDecide(id, allow, p.digest);
      return this.dropPolicy(id, true);
    }
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
      a.origin = this.origin(a.task);
      this.pending.set(a.id, a);
      this.emit('added', a);
      this.emit('changed', this.list());
    } else if (event.type === 'credential') {
      const v = event as Record<string, unknown>;
      const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');
      this.emit('credential', {
        task: str(v.task, 40),
        agent: str(v.agent, 40),
        method: str(v.method, 10),
        host: str(v.host, 200),
        path: str(v.path, 200),
      });
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
    kind: 'proxy',
    task: str(v.task, 40),
    agent: str(v.agent, 40),
    connector: str(v.connector, 20),
    operation: str(v.operation, 300),
    host: str(v.host, 200),
    summary: str(v.summary, 4000),
    createdAt: typeof v.created_at === 'number' ? v.created_at * 1000 : Date.now(),
    timeout: typeof v.timeout === 'number' ? v.timeout : 300,
    reason: str(v.reason, 200),
    origin: '',
  };
}
