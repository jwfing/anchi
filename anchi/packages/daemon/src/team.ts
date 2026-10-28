import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveAgent, type HomeLayout, type ResolvedAgent } from '@anchi/core';
import {
  teamKeySchema,
  teamCancelSchema,
  teamPollSchema,
  teamReplySchema,
  teamRunSchema,
  teamToolSchema,
  type Approval,
  type TeamDescription,
  type TeamKey,
  type TeamSnapshot,
  type TaskRow,
} from '@anchi/protocol';
import { z } from 'zod';
import type { Hub } from './hub.ts';
import { Store, EVENTS_PAGE_LIMIT } from './store.ts';
import { APPROVAL_PENDING, BASE_TOOLS, DELEGATION_TOOLS, LIST_TOOLS } from './tools.ts';

const jobSchema = z.strictObject({
  key: teamKeySchema,
  task: z.string(),
  agent: z.string(),
  turn: z.number().int(),
});
const requestSchema = teamToolSchema.safeExtend({
  task: z.string(),
  outcome: teamReplySchema.shape.outcome.optional(),
});
const receiptSchema = z.strictObject({ digest: z.string() });
const keyOf = (key: TeamKey) => `${key.coordinator}/${key.task}`;
export const teamDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Check both the fixed tool surface and the execution node's own delegation grant. */
export function validateTeamTool(agent: ResolvedAgent, name: string, args: unknown): void {
  const tool = [...BASE_TOOLS, ...DELEGATION_TOOLS].find((candidate) => candidate.name === name);
  if (!tool || !tool.available(agent)) throw new Error('TEAM_TOOL_DENIED');
  const parsed = z.record(z.string(), z.unknown()).parse(tool.args.parse(args));
  if (name === 'anchi_delegate_task' && !agent.delegates.includes(String(parsed.agent))) {
    throw new Error('TEAM_DELEGATE_DENIED');
  }
}

/**
 * Execution-node half of a team. The owner socket authenticates the coordinator. A cell can
 * only queue validated Anchi calls for its own task, never choose a peer or call admin RPCs.
 */
export class TeamWorker {
  private stopped = false;

  constructor(
    private opts: {
      store: Store;
      hub: Hub;
      layout: HomeLayout;
      approvals(): Approval[];
      decide(id: string, allow: boolean): Promise<void>;
    },
  ) {}

  describe(raw: unknown): TeamDescription {
    const { agent: id } = z.strictObject({ agent: teamRunSchema.shape.agent }).parse(raw);
    let agent: ResolvedAgent;
    try {
      agent = resolveAgent(id, this.opts.layout);
    } catch {
      throw new Error(
        `TEAM_AGENT_UNAVAILABLE: agent ${id} is missing or invalid on the execution node`,
      );
    }
    if (agent.execution)
      throw new Error('TEAM_NESTED_EXECUTION: select an agent that executes on this node');
    return {
      node: this.opts.store.nodeId(),
      agent: id,
      name: agent.name,
      description: agent.description ?? '',
      runtime: agent.runtime,
      delegates: agent.delegates,
      connectors: agent.connectors,
      skills: agent.skills,
    };
  }

  run(raw: unknown): null {
    const params = teamRunSchema.parse(raw);
    if (params.origin.coordinator === this.opts.store.nodeId())
      throw new Error('TEAM_SELF_EXECUTION');
    this.describe({ agent: params.agent });
    const key = { coordinator: params.origin.coordinator, task: params.origin.task };
    const name = keyOf(key);
    const receiptKey = `received/${name}/${params.turn}`;
    const digest = teamDigest(params);
    this.opts.store.transaction(() => {
      const receipt = this.opts.store.teamGet(receiptKey, receiptSchema);
      if (receipt) {
        if (receipt.digest !== digest) throw new Error('TEAM_REQUEST_CONFLICT');
        return;
      }
      const existing = this.opts.store.teamGet(`worker/${name}`, jobSchema);
      if (existing && existing.agent !== params.agent) throw new Error('TEAM_TARGET_CHANGED');
      if (params.turn !== (existing?.turn ?? 0) + 1) throw new Error('TEAM_TURN_OUT_OF_ORDER');
      const cancelled = this.opts.store.teamGet(`cancel/${name}`, z.number().int()) ?? 0;
      const task =
        cancelled >= params.turn
          ? existing
            ? this.opts.hub.getTask(existing.task)
            : this.opts.store.createTask({
                agentId: params.agent,
                title: params.text,
                trigger: 'delegation',
              })
          : existing
            ? this.opts.hub.sendTask(existing.task, params.text)
            : this.opts.hub.createTask(params.agent, params.text, 'delegation');
      if (cancelled >= params.turn) {
        this.opts.hub.cancelTask(task.id);
        this.opts.store.setStatus(task.id, 'cancelled');
        this.opts.store.setResult(task.id, 'cancelled before dispatch');
      }
      this.opts.store.setTeamOrigin(task.id, params.origin);
      if (existing) this.opts.store.teamDeletePrefix(`request/${task.id}/`);
      this.opts.store.teamPut(`worker/${name}`, {
        key,
        agent: params.agent,
        task: task.id,
        turn: params.turn,
      });
      this.opts.store.teamPut(`worker-task/${task.id}`, key);
      this.opts.store.teamPut(receiptKey, { digest });
    });
    return null;
  }

  private job(raw: unknown) {
    const key = teamKeySchema.parse(raw);
    const job = this.opts.store.teamGet(`worker/${keyOf(key)}`, jobSchema);
    if (!job || !this.opts.store.getTask(job.task)) throw new Error('TEAM_UNKNOWN_EXECUTION');
    return job;
  }

  poll(raw: unknown): TeamSnapshot {
    const { afterSeq, ...key } = teamPollSchema.parse(raw);
    const job = this.job(key);
    const task = this.opts.hub.getTask(job.task);
    return {
      task: {
        id: task.id,
        status: task.status,
        runtime: task.runtime ?? null,
        result: task.result,
        turns: task.turns,
      },
      events: this.opts.store.events(task.id, afterSeq, EVENTS_PAGE_LIMIT),
      requests: this.opts.store
        .teamEntries(`request/${task.id}/`, requestSchema)
        .filter(
          (request) =>
            ['running', 'queued'].includes(task.status) &&
            !request.outcome &&
            request.turn === job.turn,
        )
        .slice(0, 16)
        .map(({ task: _task, outcome: _outcome, ...request }) => request),
      approvals: this.opts
        .approvals()
        .filter((approval) => approval.task === task.id)
        .slice(0, 16),
    };
  }

  reply(raw: unknown): null {
    const { request: id, outcome, ...key } = teamReplySchema.parse(raw);
    if (JSON.stringify(outcome).length > 200_000) throw new Error('TEAM_REPLY_TOO_LARGE');
    const job = this.job(key);
    const path = `request/${job.task}/${id}`;
    const request = this.opts.store.teamGet(path, requestSchema);
    if (!request || request.turn !== job.turn) throw new Error('TEAM_UNKNOWN_REQUEST');
    if (request.outcome && teamDigest(request.outcome) !== teamDigest(outcome))
      throw new Error('TEAM_REPLY_CONFLICT');
    this.opts.store.teamPut(path, { ...request, outcome });
    return null;
  }

  cancel(raw: unknown): null {
    const { turn, ...key } = teamCancelSchema.parse(raw);
    const name = keyOf(key);
    this.opts.store.transaction(() => {
      const previous = this.opts.store.teamGet(`cancel/${name}`, z.number().int()) ?? 0;
      this.opts.store.teamPut(`cancel/${name}`, Math.max(turn, previous));
      const job = this.opts.store.teamGet(`worker/${name}`, jobSchema);
      if (job && job.turn <= turn && this.opts.store.getTask(job.task))
        this.opts.hub.cancelTask(job.task);
    });
    return null;
  }

  async approve(raw: unknown): Promise<null> {
    const { id, allow, ...key } = teamKeySchema
      .extend({ id: z.string().min(1).max(40), allow: z.boolean() })
      .parse(raw);
    const job = this.job(key);
    if (
      !this.opts.approvals().some((approval) => approval.id === id && approval.task === job.task)
    ) {
      throw new Error('TEAM_APPROVAL_DENIED');
    }
    await this.opts.decide(id, allow);
    return null;
  }

  /** undefined leaves ordinary tasks and local connector approvals with their existing handler. */
  relay(
    task: TaskRow,
    agent: ResolvedAgent,
    frame: { id: string; turn: string; tool: string; args: Record<string, unknown> },
  ): Promise<Record<string, unknown>> | undefined {
    const key = this.opts.store.teamGet(`worker-task/${task.id}`, teamKeySchema);
    if (!key || frame.tool === APPROVAL_PENDING || frame.tool === LIST_TOOLS) return undefined;
    validateTeamTool(agent, frame.tool, frame.args);
    const job = this.job(key);
    const id = teamDigest([task.id, frame.turn, frame.id]).slice(0, 32);
    const path = `request/${task.id}/${id}`;
    const request = { id, task: task.id, turn: job.turn, tool: frame.tool, args: frame.args };
    const existing = this.opts.store.teamGet(path, requestSchema);
    if (!existing) this.opts.store.teamPut(path, requestSchema.parse(request));
    return this.awaitReply(task.id, path).then((value) => {
      // Both nodes grant delegation; discovery must advertise the same intersection.
      if (frame.tool === 'anchi_list_agents' && Array.isArray(value.agents)) {
        return {
          ...value,
          agents: value.agents.filter((item: unknown) => {
            const parsed = z.object({ id: z.string() }).safeParse(item);
            return parsed.success && agent.delegates.includes(parsed.data.id);
          }),
        };
      }
      return value;
    });
  }

  private async awaitReply(taskId: string, path: string): Promise<Record<string, unknown>> {
    while (!this.stopped) {
      const request = this.opts.store.teamGet(path, requestSchema);
      if (!request) throw new Error('TEAM_TURN_ENDED');
      if (request?.outcome) {
        if (request.outcome.kind === 'error') throw new Error(request.outcome.message);
        return request.outcome.value;
      }
      const task = this.opts.store.getTask(taskId);
      if (!task || !['running', 'queued'].includes(task.status)) throw new Error('TEAM_TURN_ENDED');
      await sleep(150);
    }
    throw new Error('TEAM_NODE_STOPPED');
  }

  stop(): void {
    this.stopped = true;
  }
}
