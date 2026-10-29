import { createHash } from 'node:crypto';
import { resolveAgent, type HomeLayout } from '@anchi/core';
import {
  peerAgentRefSchema,
  peerBudgetSchema,
  peerDispatchSchema,
  peerJobKeySchema,
  peerPollSchema,
  peerCancelSchema,
  peerApproveSchema,
  peerSnapshotSchema,
  type AgentSummary,
  type Approval,
  type PeerBudget,
  type PeerDispatch,
  type PeerSnapshot,
  type TaskRow,
} from '@anchi/protocol';
import { z } from 'zod';
import type { Hub } from './hub.ts';
import type { PeerNetwork } from './peer-network.ts';
import type { Store } from './store.ts';

const outgoingSchema = z.strictObject({
  task: z.string(),
  dispatch: peerDispatchSchema,
  cursor: z.number().int().nonnegative(),
  cancelled: z.boolean(),
  settled: z.boolean(),
  error: z.string().max(2000).optional(),
});
const incomingSchema = z.strictObject({
  task: z.string(),
  turn: z.number().int(),
  identity: z.string(),
});
const approvalRouteSchema = z.strictObject({
  task: z.string(),
  remote: z.string(),
  approval: peerSnapshotSchema.shape.approvals.element,
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (task: TaskRow) => !['queued', 'running'].includes(task.status);

/** Each parent persists its own outbox. Executors keep receipts, cells and policy locally. */
export class PeerTasks {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private active = new Map<string, Promise<void>>();

  constructor(
    private opts: {
      store: Store;
      hub: Hub;
      network: PeerNetwork;
      layout: HomeLayout;
      approvals(): Approval[];
      decide(id: string, allow: boolean): Promise<void>;
      changed(): void;
      pollMs?: number;
    },
  ) {}

  agents(): AgentSummary[] {
    const directory = this.opts.network.directory();
    return directory.nodes
      .filter((n) => n.node !== directory.self)
      .flatMap((n) =>
        n.agents.map((a) => ({
          peer: { node: n.node, agent: a.id, machine: n.label, online: n.online },
          id: `${n.node}/${a.id}/${a.generation}`,
          name: `${a.name} · ${n.label}`,
          description: a.description,
          runtime: a.runtime,
          connectors: a.connectors,
          skills: a.skills,
          status: n.online ? ('idle' as const) : ('error' as const),
          ...(n.online ? {} : { error: 'Machine offline; last known directory' }),
          running: 0,
          queued: 0,
          maxTasks: 1,
          file: '',
        })),
      );
  }

  create(target: string, text: string): TaskRow {
    peerAgentRefSchema.parse(target);
    if (!this.agents().some((a) => a.id === target)) throw new Error('PEER_AGENT_UNAVAILABLE');
    return this.opts.store.transaction(() => {
      const task = this.opts.store.createTask({ agentId: target, trigger: 'user', title: text });
      const root = { node: this.opts.network.node, task: task.id };
      this.opts.store.setPeer(task.id, {
        kind: 'mirror',
        node: target.split('/')[0]!,
        agent: target,
        remoteTask: null,
        root,
      });
      const dispatch: PeerDispatch = {
        request: task.id,
        parent: null,
        root,
        target,
        lineage: [target],
        budget: { start: 0, end: 60 },
        turn: 1,
        text,
      };
      this.opts.store.teamPut(`peer/out/${task.id}`, {
        task: task.id,
        dispatch,
        cursor: 0,
        cancelled: false,
        settled: false,
      });
      const row = this.opts.hub.getTask(task.id);
      this.opts.hub.emit('task', row);
      return row;
    });
  }

  private localRef(id: string): string {
    const own = this.opts.network.identity();
    const agent = own.agents.find((a) => a.id === id);
    if (!agent) throw new Error('PEER_AGENT_UNAVAILABLE');
    return `${own.node}/${id}/${agent.generation}`;
  }

  root(task: TaskRow): TaskRow {
    if (!this.opts.network.directory().configured || task.execution || task.agentId === 'builder')
      return task;
    this.opts.store.setPeer(task.id, {
      kind: 'execution',
      root: { node: this.opts.network.node, task: task.id },
      parent: null,
      lineage: [this.localRef(task.agentId)],
    });
    this.opts.store.teamPut(`peer/budget/${task.id}`, { start: 0, end: 60 });
    return this.opts.hub.getTask(task.id);
  }

  consume(task: TaskRow): void {
    if (task.peer?.kind !== 'execution') return;
    const key = `peer/budget/${task.id}`;
    const budget = this.opts.store.teamGet(key, peerBudgetSchema);
    if (!budget || budget.start >= budget.end) throw new Error('PEER_TURN_BUDGET_EXHAUSTED');
    this.opts.store.teamPut(key, { ...budget, start: budget.start + 1 });
  }

  private allocate(parent: TaskRow, target: string): { budget: PeerBudget; lineage: string[] } {
    const info = parent.peer;
    if (info?.kind !== 'execution')
      throw new Error(
        'Start a new task after enabling peer networking to delegate across machines.',
      );
    if (info.lineage.length >= 4) throw new Error('delegation is limited to 3 levels');
    if (info.lineage.includes(target)) throw new Error('PEER_DELEGATION_CYCLE');
    const key = `peer/budget/${parent.id}`;
    const remaining = this.opts.store.teamGet(key, peerBudgetSchema);
    if (!remaining || remaining.end <= remaining.start)
      throw new Error('PEER_TURN_BUDGET_EXHAUSTED');
    // Disjoint ranges need no central counter and remain spent/reserved during a partition.
    const size = Math.min(10, Math.max(1, Math.floor((remaining.end - remaining.start) / 2)));
    const budget = { start: remaining.end - size, end: remaining.end };
    this.opts.store.teamPut(key, { start: remaining.start, end: budget.start });
    return { budget, lineage: [...info.lineage, target] };
  }

  localChild(parent: TaskRow, child: TaskRow): TaskRow {
    if (!parent.peer) return child;
    if (child.execution) throw new Error('PEER_LEGACY_EXECUTION_DENIED');
    const { budget, lineage } = this.allocate(parent, this.localRef(child.agentId));
    if (parent.peer.kind !== 'execution') throw new Error('PEER_ORIGIN_DENIED');
    this.opts.store.setPeer(child.id, {
      kind: 'execution',
      root: parent.peer.root,
      parent: { node: this.opts.network.node, task: parent.id },
      lineage,
    });
    this.opts.store.teamPut(`peer/budget/${child.id}`, budget);
    return this.opts.hub.getTask(child.id);
  }

  delegate(parent: TaskRow, target: string, text: string): TaskRow {
    peerAgentRefSchema.parse(target);
    if (!this.agents().some((a) => a.id === target)) throw new Error('PEER_AGENT_UNAVAILABLE');
    return this.opts.store.transaction(() => {
      const { budget, lineage } = this.allocate(parent, target);
      if (parent.peer?.kind !== 'execution') throw new Error('PEER_ORIGIN_DENIED');
      const task = this.opts.store.createTask({
        agentId: target,
        trigger: 'delegation',
        title: text,
        parent,
      });
      const node = target.split('/')[0]!;
      this.opts.store.setPeer(task.id, {
        kind: 'mirror',
        node,
        agent: target,
        remoteTask: null,
        root: parent.peer.root,
      });
      const dispatch: PeerDispatch = {
        request: task.id,
        parent: { node: this.opts.network.node, task: parent.id },
        root: parent.peer.root,
        target,
        lineage,
        budget,
        turn: 1,
        text,
      };
      this.opts.store.teamPut(`peer/out/${task.id}`, {
        task: task.id,
        dispatch,
        cursor: 0,
        cancelled: false,
        settled: false,
      });
      this.opts.hub.notice(parent.id, `Delegated to ${target} as ${task.id}`);
      const row = this.opts.hub.getTask(task.id);
      this.opts.hub.emit('task', row);
      return row;
    });
  }

  send(task: TaskRow, text: string): TaskRow {
    const job = this.opts.store.teamGet(`peer/out/${task.id}`, outgoingSchema);
    if (!job || task.peer?.kind !== 'mirror' || task.peer.observed)
      throw new Error('PEER_TASK_READ_ONLY');
    if (!terminal(task) || !job.settled)
      throw new Error('this task already has a turn in progress');
    job.dispatch = peerDispatchSchema.parse({ ...job.dispatch, turn: job.dispatch.turn + 1, text });
    job.cancelled = false;
    job.settled = false;
    this.opts.store.teamPut(`peer/out/${task.id}`, job);
    const row = this.opts.store.setStatus(task.id, 'queued');
    this.opts.hub.emit('task', row);
    return row;
  }

  cancel(task: TaskRow): void {
    const job = this.opts.store.teamGet(`peer/out/${task.id}`, outgoingSchema);
    if (!job) return;
    this.opts.store.teamPut(`peer/out/${task.id}`, { ...job, cancelled: true, settled: false });
    this.opts.hub.notice(task.id, 'Cancellation requested; waiting for the execution machine.');
  }

  async handle(node: string, method: string, raw: unknown): Promise<unknown> {
    if (method === 'task.run') return this.run(node, raw);
    if (method === 'task.cancel') {
      const { request, turn } = peerCancelSchema.parse(raw);
      const key = `${node}/${request}`;
      this.opts.store.transaction(() => {
        const previous = this.opts.store.teamGet(`peer/cancel/${key}`, z.number()) ?? 0;
        this.opts.store.teamPut(`peer/cancel/${key}`, Math.max(previous, turn));
        const job = this.opts.store.teamGet(`peer/in/${key}`, incomingSchema);
        if (job && job.turn <= turn && this.opts.store.getTask(job.task))
          this.opts.hub.cancelTask(job.task);
      });
      return null;
    }
    if (method === 'task.poll') {
      const { afterSeq, request } = peerPollSchema.parse(raw);
      const task = this.job(node, { request });
      const tree = this.opts.store.tree(task.id);
      const ids = new Set(tree.map((t) => t.id));
      const page = this.opts.store.events(task.id, afterSeq, 100);
      let approvalBytes = 0;
      const approvals = [...this.opts.approvals(), ...this.listApprovals()]
        .filter((a) => {
          if (!ids.has(a.task)) return false;
          const bytes = Buffer.byteLength(JSON.stringify(a));
          if (approvalBytes + bytes > 2_000_000) return false;
          approvalBytes += bytes;
          return true;
        })
        .slice(0, 100);
      return peerSnapshotSchema.parse({
        nextSeq: page.at(-1)?.seq ?? afterSeq,
        hasMore: page.length === 100,
        task: {
          id: task.id,
          status: task.status,
          runtime: task.runtime ?? null,
          result: task.result,
          turns: task.turns,
        },
        events: page.filter((e) => e.event.type !== 'session.started'),
        approvals,
        descendants: tree
          .filter((t) => t.id !== task.id)
          .map((t) => ({
            id: t.id,
            parent: t.parentId,
            agent: t.peer?.kind === 'mirror' ? t.peer.agent : this.localRef(t.agentId),
            title: t.title,
            status: t.status,
            result: t.result,
            turns: t.turns,
          })),
      });
    }
    if (method === 'task.approve') {
      const { id, allow, request } = peerApproveSchema.parse(raw);
      const task = this.job(node, { request });
      const ids = new Set(this.opts.store.tree(task.id).map((t) => t.id));
      const approval = [...this.opts.approvals(), ...this.listApprovals()].find(
        (a) => a.id === id && ids.has(a.task),
      );
      if (!approval) throw new Error('PEER_APPROVAL_DENIED');
      if (!(await this.decide(id, allow))) await this.opts.decide(id, allow);
      return null;
    }
    throw new Error('PEER_METHOD_DENIED');
  }

  private job(node: string, raw: unknown): TaskRow {
    const { request } = peerJobKeySchema.parse(raw);
    const job = this.opts.store.teamGet(`peer/in/${node}/${request}`, incomingSchema);
    const task = job && this.opts.store.getTask(job.task);
    if (!task) throw new Error('PEER_UNKNOWN_EXECUTION');
    return task;
  }

  private run(node: string, raw: unknown): null {
    const p = peerDispatchSchema.parse(raw);
    const [targetNode, agentId] = p.target.split('/');
    const originValid = p.parent
      ? p.parent.node === node && p.lineage.length >= 2 && p.lineage.at(-2)?.split('/')[0] === node
      : p.lineage.length === 1 && p.root.node === node && p.root.task === p.request;
    if (
      !originValid ||
      p.lineage.at(-1) !== p.target ||
      new Set(p.lineage).size !== p.lineage.length ||
      targetNode !== this.opts.network.node
    )
      throw new Error('PEER_ORIGIN_DENIED');
    if (this.localRef(agentId!) !== p.target) throw new Error('PEER_AGENT_GENERATION_CHANGED');
    if (resolveAgent(agentId!, this.opts.layout).execution)
      throw new Error('PEER_LEGACY_EXECUTION_DENIED');
    if (p.budget.end <= p.budget.start) throw new Error('PEER_TURN_BUDGET_EXHAUSTED');
    const key = `${node}/${p.request}`;
    const receiptKey = `peer/receipt/${key}/${p.turn}`;
    const identity = digest({ ...p, turn: 0, text: '' });
    this.opts.store.transaction(() => {
      const receipt = this.opts.store.teamGet(receiptKey, z.string());
      if (receipt) {
        if (receipt !== digest(p)) throw new Error('PEER_REQUEST_CONFLICT');
        return;
      }
      const job = this.opts.store.teamGet(`peer/in/${key}`, incomingSchema);
      if (job && job.identity !== identity) throw new Error('PEER_REQUEST_CONFLICT');
      if (p.turn !== (job?.turn ?? 0) + 1) throw new Error('PEER_TURN_OUT_OF_ORDER');
      const cancelled = (this.opts.store.teamGet(`peer/cancel/${key}`, z.number()) ?? 0) >= p.turn;
      const task = cancelled
        ? job
          ? this.opts.hub.getTask(job.task)
          : this.opts.store.createTask({ agentId: agentId!, trigger: 'delegation', title: p.text })
        : job
          ? this.opts.hub.sendTask(job.task, p.text)
          : this.opts.hub.createTask(agentId!, p.text, 'delegation');
      if (!job) {
        this.opts.store.setPeer(task.id, {
          kind: 'execution',
          parent: p.parent,
          root: p.root,
          lineage: p.lineage,
        });
        this.opts.store.teamPut(`peer/budget/${task.id}`, p.budget);
      }
      if (cancelled) {
        this.opts.hub.cancelTask(task.id);
        this.opts.store.setStatus(task.id, 'cancelled');
        this.opts.store.setResult(task.id, 'cancelled before dispatch');
      }
      this.opts.store.teamPut(`peer/in/${key}`, { task: task.id, turn: p.turn, identity });
      this.opts.store.teamPut(receiptKey, digest(p));
    });
    return null;
  }

  listApprovals(): Approval[] {
    return this.opts.store
      .teamEntries('peer/approval/', approvalRouteSchema)
      .map((r) => r.approval);
  }

  async decide(id: string, allow: boolean): Promise<boolean> {
    const route = this.opts.store.teamGet(`peer/approval/${id}`, approvalRouteSchema);
    if (!route) return false;
    const task = this.opts.hub.getTask(route.task);
    if (task.peer?.kind !== 'mirror' || task.peer.observed) throw new Error('PEER_APPROVAL_DENIED');
    await this.opts.network.request(task.peer.node, 'task.approve', {
      request: task.id,
      id: route.remote,
      allow,
    });
    this.opts.store.teamDeletePrefix(`peer/approval/${id}`);
    this.opts.changed();
    return true;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 1000);
    this.timer.unref();
    this.tick();
  }

  private tick(): void {
    if (this.stopped) return;
    for (const job of this.opts.store.teamEntries('peer/out/', outgoingSchema)) {
      if (job.settled || this.active.has(job.task) || !this.opts.store.getTask(job.task)) continue;
      const work = this.sync(job.task)
        .catch((error) => {
          if (this.stopped) return;
          const current = this.opts.store.teamGet(`peer/out/${job.task}`, outgoingSchema);
          if (!current) return;
          const message = String(error).slice(0, 2000);
          if (current.error !== message) {
            this.opts.store.teamPut(`peer/out/${job.task}`, { ...current, error: message });
            this.opts.hub.notice(job.task, `Peer request could not complete: ${message}`);
          }
          if (
            /PEER_(AGENT_|ORIGIN_|REQUEST_CONFLICT|TURN_|LEGACY_|UNKNOWN_EXECUTION|REVOKED|NOT_PAIRED|TASK_TREE_INVALID|SNAPSHOT_INVALID)/.test(
              String(error),
            )
          ) {
            const current = this.opts.store.teamGet(`peer/out/${job.task}`, outgoingSchema);
            if (!current) return;
            this.opts.store.teamPut(`peer/out/${job.task}`, { ...current, settled: true });
            this.opts.hub.finish(job.task, 'failed', String(error).slice(0, 2000));
          }
        })
        .finally(() => this.active.delete(job.task));
      this.active.set(job.task, work);
    }
  }

  private async sync(id: string): Promise<void> {
    const job = this.opts.store.teamGet(`peer/out/${id}`, outgoingSchema)!;
    const node = job.dispatch.target.split('/')[0]!;
    if (job.cancelled)
      await this.opts.network.request(node, 'task.cancel', {
        request: id,
        turn: job.dispatch.turn,
      });
    await this.opts.network.request(node, 'task.run', job.dispatch);
    const snapshot = peerSnapshotSchema.parse(
      await this.opts.network.request(node, 'task.poll', { request: id, afterSeq: job.cursor }),
    );
    if (this.stopped) return;
    this.opts.store.transaction(() => {
      const current = this.opts.store.teamGet(`peer/out/${id}`, outgoingSchema);
      if (!current || current.dispatch.turn !== job.dispatch.turn) return;
      const task = this.opts.hub.getTask(id);
      if (task.peer?.kind !== 'mirror') throw new Error('PEER_TASK_INVALID');
      this.opts.store.setPeer(id, { ...task.peer, remoteTask: snapshot.task.id });
      if (snapshot.task.runtime) this.opts.store.setRuntime(id, snapshot.task.runtime);
      const mapped = this.mirrorTree(task, snapshot);
      if (current.error) {
        delete current.error;
        this.opts.hub.notice(id, 'Peer connection restored; synchronized the existing task.');
      }
      for (const event of snapshot.events) {
        if (event.seq <= current.cursor) continue;
        if (event.event.type !== 'session.started') this.opts.hub.record(task, event.event);
        current.cursor = event.seq;
      }
      if (
        snapshot.nextSeq < current.cursor ||
        snapshot.events.some((e) => e.seq > snapshot.nextSeq)
      )
        throw new Error('PEER_SNAPSHOT_INVALID');
      current.cursor = snapshot.nextSeq;
      for (const route of this.opts.store.teamEntries('peer/approval/', approvalRouteSchema))
        if (route.task === id)
          this.opts.store.teamDeletePrefix(`peer/approval/${route.approval.id}`);
      for (const a of snapshot.approvals) {
        const approvalId = digest([node, id, a.id]).slice(0, 32);
        const localTask = mapped.get(a.task);
        if (!localTask) throw new Error('PEER_APPROVAL_DENIED');
        this.opts.store.teamPut(`peer/approval/${approvalId}`, {
          task: id,
          remote: a.id,
          approval: {
            ...a,
            id: approvalId,
            task: localTask,
            agent: this.opts.hub.getTask(localTask).agentId,
          },
        });
      }
      this.opts.store.setPeerTurns(id, snapshot.task.turns);
      // Drain pages before finishing, so a waiter never sees a result without its transcript.
      const complete = !['queued', 'running'].includes(snapshot.task.status) && !snapshot.hasMore;
      current.settled =
        complete &&
        snapshot.descendants.every((t) => !['running', 'queued'].includes(t.status)) &&
        (!current.cancelled || job.cancelled);
      this.opts.store.teamPut(`peer/out/${id}`, current);
      if (
        complete &&
        (!current.cancelled || job.cancelled) &&
        (!terminal(task) || task.result !== snapshot.task.result)
      )
        this.opts.hub.finish(
          id,
          snapshot.task.status as 'done' | 'failed' | 'cancelled',
          snapshot.task.result ?? '',
        );
      else if (task.status === 'queued')
        this.opts.hub.emit('task', this.opts.store.setStatus(id, 'running'));
      this.opts.changed();
    });
  }

  private mirrorTree(parent: TaskRow, snapshot: PeerSnapshot): Map<string, string> {
    const depths = new Map([[snapshot.task.id, parent.depth]]);
    const remaining = [...snapshot.descendants];
    if (new Set([snapshot.task.id, ...remaining.map((t) => t.id)]).size !== remaining.length + 1)
      throw new Error('PEER_TASK_TREE_INVALID');
    while (remaining.length) {
      const index = remaining.findIndex((t) => depths.has(t.parent));
      if (index < 0) throw new Error('PEER_TASK_TREE_INVALID');
      const task = remaining.splice(index, 1)[0]!;
      const depth = depths.get(task.parent)! + 1;
      if (depth > 3) throw new Error('PEER_TASK_TREE_INVALID');
      depths.set(task.id, depth);
    }
    if (snapshot.approvals.some((a) => !depths.has(a.task)))
      throw new Error('PEER_SNAPSHOT_INVALID');
    const mapping = new Map<string, string>([[snapshot.task.id, parent.id]]);
    const pending = [...snapshot.descendants];
    while (pending.length) {
      const index = pending.findIndex((t) => mapping.has(t.parent));
      if (index < 0) throw new Error('PEER_TASK_TREE_INVALID');
      const t = pending.splice(index, 1)[0]!;
      const key = `peer/shadow/${parent.id}/${t.id}`;
      let id = this.opts.store.teamGet(key, z.string());
      if (!id) {
        const child = this.opts.store.createTask({
          agentId: t.agent,
          title: t.title,
          trigger: 'delegation',
          parent: this.opts.hub.getTask(mapping.get(t.parent)!),
        });
        if (child.depth > 3) throw new Error('PEER_TASK_TREE_INVALID');
        id = child.id;
        if (parent.peer?.kind !== 'mirror') throw new Error('PEER_TASK_INVALID');
        this.opts.store.setPeer(id, {
          ...parent.peer,
          agent: t.agent,
          remoteTask: t.id,
          observed: true,
        });
        this.opts.store.teamPut(key, id);
      }
      this.opts.store.setPeerTurns(id, t.turns);
      if (t.result !== null) this.opts.store.setResult(id, t.result);
      this.opts.hub.emit('task', this.opts.store.setStatus(id, t.status));
      mapping.set(t.id, id);
    }
    return mapping;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
  }
}
