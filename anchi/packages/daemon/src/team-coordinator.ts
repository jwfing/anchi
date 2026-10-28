import { setTimeout as sleep } from 'node:timers/promises';
import { resolveAgent, type HomeLayout, type ResolvedAgent } from '@anchi/core';
import {
  executionSchema,
  teamDescribeSchema,
  teamOriginSchema,
  teamReplySchema,
  teamRunSchema,
  teamSnapshotSchema,
  type Approval,
  type Execution,
  type RuntimeEvent,
  type TaskRow,
  type TeamDescription,
  type TeamReply,
  type TeamTool,
} from '@anchi/protocol';
import { z } from 'zod';
import { connectRemote, parseServer, resolveServer } from './remote.ts';
import { DaemonClient } from './rpc.ts';
import type { Store } from './store.ts';
import type { ToolDispatcher } from './tools.ts';
import { teamDigest, validateTeamTool } from './team.ts';

const outboundSchema = z.strictObject({
  task: z.string(),
  execution: executionSchema,
  target: z.string(),
  node: z.string(),
  origin: teamOriginSchema,
  turn: z.number().int().positive(),
  text: z.string().max(200_000),
  afterSeq: z.number().int().nonnegative(),
  cancel: z.boolean(),
  active: z.boolean(),
});
type Outbound = z.infer<typeof outboundSchema>;
const outcomeSchema = z.strictObject({
  digest: z.string(),
  outcome: teamReplySchema.shape.outcome,
});
type RemoteOutcome =
  | { kind: 'paused' }
  | { kind: 'finished'; status: 'done' | 'failed' | 'cancelled'; result: string };

export class TeamCoordinator {
  private connections = new Map<string, Promise<DaemonClient>>();
  private approvals = new Map<string, { approval: Approval; remoteId: string; job: Outbound }>();
  private calls = new Map<string, Promise<void>>();
  private running = new Set<Promise<RemoteOutcome>>();
  private stopped = new AbortController();

  constructor(
    private opts: {
      layout: HomeLayout;
      store: Store;
      tools: ToolDispatcher;
      origin(task: string): string[];
      record(task: TaskRow, event: RuntimeEvent): void;
      changed(): void;
      connect?: (target: string) => Promise<DaemonClient>;
      pollMs?: number;
    },
  ) {}

  private async connection(target: string): Promise<DaemonClient> {
    let pending = this.connections.get(target);
    if (!pending) {
      pending = (async () => {
        const parsed = parseServer(target);
        if (parsed.kind !== 'remote') throw new Error('TEAM_REMOTE_REQUIRED');
        const client = this.opts.connect
          ? await this.opts.connect(target)
          : await connectRemote(parsed, () => {});
        client.onClose(() => {
          if (this.connections.get(target) === pending) this.connections.delete(target);
        });
        return client;
      })();
      this.connections.set(target, pending);
      void pending.catch(() => {
        if (this.connections.get(target) === pending) this.connections.delete(target);
      });
    }
    return pending;
  }

  /** Execution requests are idempotent; a lost connection can safely repeat them. */
  private async request<T>(target: string, call: (client: DaemonClient) => Promise<T>): Promise<T> {
    const client = await this.connection(target);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            client.close();
            reject(new Error('TEAM_CONNECTION_TIMEOUT'));
          }, 20_000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private target(execution: Execution): string {
    const target = resolveServer(this.opts.layout.root, execution.server);
    if (target.kind !== 'remote') throw new Error('TEAM_REMOTE_REQUIRED');
    return target.name;
  }

  async describe(execution: Execution): Promise<TeamDescription> {
    const description = teamDescribeSchema.parse(
      await this.request(this.target(execution), (client) =>
        client.call('team.describe', { agent: execution.agent }),
      ),
    );
    if (description.node === this.opts.store.nodeId()) throw new Error('TEAM_SELF_EXECUTION');
    return description;
  }

  active(task: string): boolean {
    return this.opts.store.teamGet(`outbound/${task}`, outboundSchema)?.active === true;
  }

  cancel(task: string): void {
    const job = this.opts.store.teamGet(`outbound/${task}`, outboundSchema);
    if (job?.active) this.opts.store.teamPut(`outbound/${task}`, { ...job, cancel: true });
  }

  resumeText(task: string): string | undefined {
    const job = this.opts.store.teamGet(`outbound/${task}`, outboundSchema);
    return job?.active ? job.text : undefined;
  }

  run(
    task: TaskRow,
    agent: ResolvedAgent,
    text: string,
    signal: AbortSignal,
  ): Promise<RemoteOutcome> {
    const promise = this.execute(task, agent, text, signal);
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise)).catch(() => {});
    return promise;
  }

  private async execute(
    task: TaskRow,
    agent: ResolvedAgent,
    text: string,
    signal: AbortSignal,
  ): Promise<RemoteOutcome> {
    const execution = task.execution ?? agent.execution;
    if (!execution) throw new Error('TEAM_EXECUTION_MISSING');
    let job = this.opts.store.teamGet(`outbound/${task.id}`, outboundSchema);
    if (!job?.active) {
      const previous = job;
      job = {
        task: task.id,
        execution,
        target: previous?.target ?? this.target(execution),
        node: previous?.node ?? '',
        origin: {
          coordinator: this.opts.store.nodeId(),
          task: task.id,
          agent: task.agentId,
          chain: this.opts.origin(task.id).map((part) => part.slice(0, 200)),
        },
        turn: (previous?.turn ?? 0) + 1,
        text,
        afterSeq: previous?.afterSeq ?? 0,
        cancel: false,
        active: true,
      };
      if (previous && teamDigest(previous.execution) !== teamDigest(execution))
        throw new Error('TEAM_TARGET_CHANGED');
      this.opts.store.transaction(() => {
        this.opts.store.teamPut(`outbound/${task.id}`, job);
        this.opts.store.setExecution(task.id, execution);
        if (previous) {
          this.opts.store.teamDeletePrefix(`answer/${task.id}/${previous.turn}/`);
          this.opts.store.teamDeletePrefix(`effect/${task.id}/${previous.turn}/`);
        }
      });
    }
    const key = { coordinator: job.origin.coordinator, task: job.origin.task };
    const save = () => {
      const persisted = this.opts.store.teamGet(`outbound/${task.id}`, outboundSchema);
      if (persisted?.turn === job.turn && persisted.cancel) job.cancel = true;
      this.opts.store.teamPut(`outbound/${task.id}`, job);
    };
    let disconnected = false;
    let started = false;
    while (!this.stopped.signal.aborted) {
      if (signal.aborted && !job.cancel) {
        job.cancel = true;
        save();
      }
      try {
        if (!started) {
          const description = teamDescribeSchema.parse(
            await this.request(job.target, (client) =>
              client.call('team.describe', { agent: job.execution.agent }),
            ),
          );
          if (this.stopped.signal.aborted) return { kind: 'paused' };
          if (description.node === this.opts.store.nodeId()) throw new Error('TEAM_SELF_EXECUTION');
          if (job.node && job.node !== description.node) throw new Error('TEAM_NODE_CHANGED');
          job.node = description.node;
          save();
          const runtime = this.opts.store.getTask(task.id)?.runtime;
          if (runtime && runtime !== description.runtime) throw new Error('TEAM_RUNTIME_CHANGED');
          this.opts.store.setRuntime(task.id, description.runtime);
          if (signal.aborted && !job.cancel) {
            job.cancel = true;
            save();
          }
          if (job.cancel)
            await this.request(job.target, (client) =>
              client.call('team.cancel', { ...key, turn: job.turn }),
            );
          const request = teamRunSchema.parse({
            origin: job.origin,
            agent: job.execution.agent,
            turn: job.turn,
            text: job.text,
          });
          await this.request(job.target, (client) => client.call('team.run', request));
          started = true;
        }
        if (job.cancel || signal.aborted) {
          job.cancel = true;
          save();
          await this.request(job.target, (client) =>
            client.call('team.cancel', { ...key, turn: job.turn }),
          );
        }
        const snapshot = teamSnapshotSchema.parse(
          await this.request(job.target, (client) =>
            client.call('team.poll', { ...key, afterSeq: job.afterSeq }),
          ),
        );
        if (disconnected) {
          this.opts.record(task, {
            type: 'notice',
            text: `Reconnected to ${execution.server}; following the same remote task.`,
          });
          disconnected = false;
        }
        const first = snapshot.events[0];
        if (first && first.seq > job.afterSeq + 1)
          this.opts.record(task, {
            type: 'notice',
            text: 'Earlier events expired on the execution node; this transcript and its usage totals may be incomplete.',
          });
        for (const stored of snapshot.events) {
          if (stored.seq <= job.afterSeq) continue;
          const before = job.afterSeq;
          try {
            this.opts.store.transaction(() => {
              // The coordinator already records the input. A worker session id must not be used locally.
              if (stored.event.type !== 'input' && stored.event.type !== 'session.started')
                this.opts.record(task, stored.event);
              job.afterSeq = stored.seq;
              save();
            });
          } catch (error) {
            job.afterSeq = before;
            throw error;
          }
        }
        this.updateApprovals(job, snapshot.approvals);
        if (!job.cancel && ['running', 'queued'].includes(snapshot.task.status))
          for (const request of snapshot.requests) {
            const callKey = `${task.id}/${request.turn}/${request.id}`;
            if (request.turn !== job.turn || this.calls.has(callKey)) continue;
            const pending = this.answer(job, task, request, callKey);
            this.calls.set(callKey, pending);
            void pending.finally(() => this.calls.delete(callKey)).catch(() => {});
          }
        // Drain events before committing the terminal state (a page can end before the result).
        if (!['queued', 'running'].includes(snapshot.task.status) && snapshot.events.length === 0) {
          job.active = false;
          save();
          this.updateApprovals(job, []);
          const status = snapshot.task.status;
          if (status === 'done' || status === 'failed' || status === 'cancelled')
            return { kind: 'finished', status, result: snapshot.task.result ?? '' };
        }
      } catch (error) {
        if (this.stopped.signal.aborted) break;
        const message = error instanceof Error ? error.message : 'Remote execution failed';
        if (
          /TEAM_(AGENT_UNAVAILABLE|NODE_CHANGED|SELF_EXECUTION|RUNTIME_CHANGED|TARGET_CHANGED|NESTED_EXECUTION|REQUEST_CONFLICT|TURN_OUT_OF_ORDER|UNKNOWN_EXECUTION)/.test(
            message,
          ) ||
          error instanceof z.ZodError ||
          /unknown method.*team\./.test(message)
        ) {
          job.active = false;
          save();
          this.updateApprovals(job, []);
          return { kind: 'finished', status: 'failed', result: message.slice(0, 2000) };
        }
        started = false;
        if (!disconnected) {
          this.opts.record(task, {
            type: 'notice',
            text: `Waiting for execution node ${execution.server}${job.cancel ? ' to confirm cancellation' : ''}. The same task will be reattached when it reconnects.`,
          });
          disconnected = true;
        }
      }
      await sleep(this.opts.pollMs ?? (disconnected ? 3000 : 400), undefined, {
        signal: this.stopped.signal,
      }).catch(() => {});
    }
    return { kind: 'paused' };
  }

  private async answer(
    job: Outbound,
    task: TaskRow,
    request: TeamTool,
    key: string,
  ): Promise<void> {
    const digest = teamDigest(request);
    const receipt = this.opts.store.teamGet(`answer/${key}`, outcomeSchema);
    let outcome: TeamReply['outcome'];
    if (receipt) {
      outcome =
        receipt.digest !== digest
          ? { kind: 'error', message: 'TEAM_REQUEST_CONFLICT' }
          : receipt.outcome;
    } else {
      try {
        const agent = resolveAgent(task.agentId, this.opts.layout);
        const current = this.opts.store.getTask(task.id);
        if (
          !current ||
          current.status !== 'running' ||
          job.cancel ||
          this.opts.store.teamGet(`outbound/${task.id}`, outboundSchema)?.cancel
        )
          throw new Error('TEAM_TURN_ENDED');
        validateTeamTool(agent, request.tool, request.args);
        const value = await this.opts.tools.call(
          { task: current, agent, requestKey: key, signal: this.stopped.signal },
          request.tool,
          request.args,
        );
        if (JSON.stringify(value).length > 200_000) throw new Error('TEAM_REPLY_TOO_LARGE');
        outcome = { kind: 'result', value };
      } catch (error) {
        outcome = {
          kind: 'error',
          message: (error instanceof Error ? error.message : 'Team tool failed').slice(0, 2000),
        };
      }
      if (this.stopped.signal.aborted) return;
      this.opts.store.teamPut(`answer/${key}`, { digest, outcome });
    }
    await this.request(job.target, (client) =>
      client.call('team.reply', {
        coordinator: job.origin.coordinator,
        task: job.origin.task,
        request: request.id,
        outcome,
      }),
    );
  }

  private updateApprovals(job: Outbound, approvals: Approval[]): void {
    const before = JSON.stringify(this.listApprovals());
    for (const [id, item] of this.approvals)
      if (item.job.task === job.task) this.approvals.delete(id);
    for (const approval of approvals) {
      const id = `r-${teamDigest([job.node, approval.id]).slice(0, 32)}`;
      this.approvals.set(id, {
        job,
        remoteId: approval.id,
        approval: {
          ...approval,
          id,
          task: job.task,
          agent: job.origin.agent,
          origin: `${job.origin.chain.join(' → ')} → ${job.execution.server}/${job.execution.agent}`,
        },
      });
    }
    if (JSON.stringify(this.listApprovals()) !== before) this.opts.changed();
  }

  listApprovals(): Approval[] {
    return [...this.approvals.values()].map((item) => item.approval);
  }

  async decide(id: string, allow: boolean): Promise<boolean> {
    const item = this.approvals.get(id);
    if (!item) return false;
    await this.request(item.job.target, (client) =>
      client.call('team.approve', {
        coordinator: item.job.origin.coordinator,
        task: item.job.origin.task,
        id: item.remoteId,
        allow,
      }),
    );
    this.approvals.delete(id);
    this.opts.changed();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped.abort();
    for (const pending of this.connections.values())
      void pending.then((client) => client.close()).catch(() => {});
    await Promise.allSettled([...this.running, ...this.calls.values()]);
  }
}
