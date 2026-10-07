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
}

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

/** Validates and runs Anchi tool calls from cells. */
export class ToolDispatcher {
  private tools = new Map<string, AnchiTool>();

  constructor(
    private host: ToolHost,
    tools: AnchiTool[] = BASE_TOOLS,
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
