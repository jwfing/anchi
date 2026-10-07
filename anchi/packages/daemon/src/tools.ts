import type { ResolvedAgent } from '@anchi/core';
import type { AgentSummary, TaskRow } from '@anchi/protocol';
import { z } from 'zod';

/** What a tool call knows about its caller; established by the daemon, never by the cell. */
export interface ToolContext {
  task: TaskRow;
  agent: ResolvedAgent;
}

/** Services the tools use, provided by the hub. */
export interface ToolHost {
  agents(): AgentSummary[];
  delegate(parent: TaskRow, parentAgent: ResolvedAgent, target: string, text: string): TaskRow;
  sendTask(taskId: string, text: string): TaskRow;
  getTask(taskId: string): TaskRow;
  children(taskId: string): TaskRow[];
  wait(taskId: string): Promise<TaskRow>;
  policyApproval(task: TaskRow, connector: string, id: string): Promise<void>;
}

/** The MCP server reports a connector write waiting for approval; not a tool the model sees. */
export const APPROVAL_PENDING = 'anchi.approval_pending';
const SERVICE = new Set(['gmail', 'drive', 'notion', 'slack']);

/** Longest a tool call waits for a delegated task; below the 60-minute turn timeout. */
export const MAX_WAIT_MINUTES = 55;

const taskId = z.string().regex(/^t-[0-9a-f]{10}$/, 'a task id such as t-0123456789');
const waitArgs = {
  wait: z
    .boolean()
    .default(true)
    .describe('Wait for the delegated turn to finish and return its result (default true).'),
  timeout_minutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_MINUTES)
    .default(30)
    .describe(
      'How long to wait; afterwards the task keeps running and its status says how it ends.',
    ),
};

function summary(t: TaskRow) {
  return { task: t.id, agent: t.agentId, status: t.status, result: t.result, links: t.links };
}

/** The task, if it was delegated by `ctx.task`; tools never reach other tasks. */
function ownChild(ctx: ToolContext, host: ToolHost, id: string): TaskRow {
  const t = host.getTask(id);
  if (t.parentId !== ctx.task.id) throw new Error(`${id} was not delegated by this task`);
  return t;
}

async function waitFor(host: ToolHost, t: TaskRow, wait: boolean, minutes: number) {
  if (!wait) return { ...summary(t), note: 'started; use anchi_task_status to follow it' };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), minutes * 60_000)));
  const done = await Promise.race([host.wait(t.id), timeout]);
  clearTimeout(timer);
  if (done) return summary(done);
  return { ...summary(host.getTask(t.id)), note: 'still running; use anchi_task_status later' };
}

const delegates = (agent: ResolvedAgent) => agent.delegates.length > 0;

export interface AnchiTool<A extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  args: A;
  /** Whether this agent is offered the tool at all. */
  available(agent: ResolvedAgent): boolean;
  run(ctx: ToolContext, args: z.infer<A>, host: ToolHost): Promise<Record<string, unknown>>;
}

/**
 * Tool names start with `anchi_` so they never collide with a runtime's own tools (Codex has a
 * built-in `list_agents`). The tool list the in-cell MCP server asks for first is not a tool.
 */
export const LIST_TOOLS = 'anchi.tools';

function tool<A extends z.ZodType>(t: AnchiTool<A>): AnchiTool {
  return t as unknown as AnchiTool;
}

export const BASE_TOOLS: AnchiTool[] = [
  tool({
    name: 'anchi_whoami',
    description: 'Your agent id and the id of the task you are working on.',
    args: z.strictObject({}),
    available: () => true,
    run: async ({ task, agent }) => ({ agent: agent.id, task: task.id }),
  }),
  tool({
    name: 'anchi_list_agents',
    description:
      'The agents you may delegate tasks to, with their descriptions and connectors. Empty if you may not delegate.',
    args: z.strictObject({}),
    available: () => true,
    run: async ({ agent }, _args, host) => ({
      agents: host
        .agents()
        .filter((a) => agent.delegates.includes(a.id))
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description ?? '',
          connectors: a.connectors,
          status: a.status,
        })),
    }),
  }),
];

export const DELEGATION_TOOLS: AnchiTool[] = [
  tool({
    name: 'anchi_delegate_task',
    description:
      'Give another agent a task (one of anchi_list_agents). It runs in its own cell with its own ' +
      'connectors. By default waits for its turn to finish and returns the result and links.',
    args: z.strictObject({
      agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
      task: z
        .string()
        .min(1)
        .max(20_000)
        .describe('What the agent should do, with all context it needs.'),
      ...waitArgs,
    }),
    available: delegates,
    run: async (ctx, a, host) =>
      waitFor(host, host.delegate(ctx.task, ctx.agent, a.agent, a.task), a.wait, a.timeout_minutes),
  }),
  tool({
    name: 'anchi_task_status',
    description: 'Status, result and links of a task you delegated.',
    args: z.strictObject({ task: taskId }),
    available: delegates,
    run: async (ctx, a, host) => summary(ownChild(ctx, host, a.task)),
  }),
  tool({
    name: 'anchi_send_to_task',
    description: 'Send a follow-up message to a task you delegated, continuing its conversation.',
    args: z.strictObject({ task: taskId, message: z.string().min(1).max(20_000), ...waitArgs }),
    available: delegates,
    run: async (ctx, a, host) => {
      ownChild(ctx, host, a.task);
      return waitFor(host, host.sendTask(a.task, a.message), a.wait, a.timeout_minutes);
    },
  }),
  tool({
    name: 'anchi_list_tasks',
    description: 'The tasks you delegated from this task, with their status.',
    args: z.strictObject({}),
    available: delegates,
    run: async (ctx, _a, host) => ({ tasks: host.children(ctx.task.id).map(summary) }),
  }),
];

/** Validates and runs Anchi tool calls from cells. */
export class ToolDispatcher {
  private tools = new Map<string, AnchiTool>();

  constructor(
    private host: ToolHost,
    tools: AnchiTool[] = [...BASE_TOOLS, ...DELEGATION_TOOLS],
  ) {
    for (const t of tools) this.add(t);
  }

  add(t: AnchiTool): void {
    if (this.tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    this.tools.set(t.name, t);
  }

  /** Tools offered to an agent, as MCP tool definitions. */
  list(agent: ResolvedAgent): { name: string; description: string; inputSchema: unknown }[] {
    return [...this.tools.values()]
      .filter((t) => t.available(agent))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.args),
      }));
  }

  async call(ctx: ToolContext, name: string, args: Record<string, unknown>) {
    if (name === LIST_TOOLS) return { tools: this.list(ctx.agent) };
    if (name === APPROVAL_PENDING) {
      const connector = String(args.connector ?? '');
      const id = String(args.approval_id ?? '');
      if (!SERVICE.has(connector) || !(ctx.agent.connectors as string[]).includes(connector)) {
        throw new Error('not a connector of this agent');
      }
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid approval id');
      await this.host.policyApproval(ctx.task, connector, id);
      return {};
    }
    const t = this.tools.get(name);
    // An unavailable tool is reported like an unknown one.
    if (!t || !t.available(ctx.agent)) throw new Error(`unknown tool ${name}`);
    const parsed = t.args.safeParse(args);
    if (!parsed.success) {
      throw new Error(`invalid arguments: ${z.prettifyError(parsed.error).slice(0, 500)}`);
    }
    return t.run(ctx, parsed.data, this.host);
  }
}
