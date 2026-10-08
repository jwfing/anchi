import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from '@openai/codex-sdk';
import {
  MAX_EVENT_TEXT,
  MAX_TOOL_OUTPUT,
  type RuntimeEvent,
  truncate,
  type TurnOptions,
} from '@anchi/protocol';

export const CODEX_PATH = '/opt/codex/bin/codex';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

export function codexOptions(
  options: TurnOptions,
  env: Record<string, string>,
): { codex: CodexOptions; thread: ThreadOptions } {
  const config: CodexConfigObject = {};
  const instructions = options.instructions?.trim();
  if (instructions) {
    // `instructions` replaces Codex's base instructions; `developer_instructions` is added on top.
    config[options.instructionsMode === 'replace' ? 'instructions' : 'developer_instructions'] =
      instructions;
  }
  return {
    codex: { codexPathOverride: CODEX_PATH, env, config },
    thread: {
      model: options.model,
      modelReasoningEffort: options.effort,
      workingDirectory: options.workdir,
      skipGitRepoCheck: true,
      // The cell is the boundary (D6). The workspace-write opt-in adds Codex's own sandbox,
      // with network access because the only network is the egress proxy anyway.
      sandboxMode: options.sandbox === 'cell' ? 'danger-full-access' : 'workspace-write',
      networkAccessEnabled: true,
      // `codex exec` cannot ask for approval mid-run.
      approvalPolicy: 'never',
    },
  };
}

const text = (s: string) => truncate(s, MAX_EVENT_TEXT);
const json = (v: unknown) => text(JSON.stringify(v ?? null));

function toolCall(item: ThreadItem): RuntimeEvent | undefined {
  switch (item.type) {
    case 'command_execution':
      return {
        type: 'tool.call',
        id: item.id,
        name: 'shell',
        input: json({ command: item.command }),
      };
    case 'mcp_tool_call':
      return {
        type: 'tool.call',
        id: item.id,
        name: `mcp__${item.server}__${item.tool}`.slice(0, 200),
        input: json(item.arguments),
      };
    case 'file_change':
      return {
        type: 'tool.call',
        id: item.id,
        name: 'apply_patch',
        input: json({ changes: item.changes }),
      };
    case 'web_search':
      return {
        type: 'tool.call',
        id: item.id,
        name: 'web_search',
        input: json({ query: item.query }),
      };
    default:
      return undefined;
  }
}

function toolResult(item: ThreadItem): RuntimeEvent | undefined {
  const out = (s: string) => truncate(s, MAX_TOOL_OUTPUT);
  switch (item.type) {
    case 'command_execution':
      return {
        type: 'tool.result',
        id: item.id,
        output: out(item.aggregated_output),
        isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
      };
    case 'mcp_tool_call':
      return {
        type: 'tool.result',
        id: item.id,
        output: out(
          item.error?.message ??
            (item.result?.content ?? [])
              .map((c) => ('text' in c ? c.text : `[${c.type}]`))
              .join('\n'),
        ),
        isError: item.status === 'failed',
      };
    case 'file_change':
      return {
        type: 'tool.result',
        id: item.id,
        output: out(item.changes.map((c) => `${c.kind} ${c.path}`).join('\n')),
        isError: item.status === 'failed',
      };
    case 'web_search':
      return { type: 'tool.result', id: item.id, output: '', isError: false };
    default:
      return undefined;
  }
}

export interface MapState {
  calls: Set<string>;
  warnings: Set<string>;
}

export function* mapCodexEvent(ev: ThreadEvent, state: MapState): Generator<RuntimeEvent> {
  switch (ev.type) {
    case 'thread.started':
      yield { type: 'session.started', resumeId: ev.thread_id.slice(0, 200) };
      return;
    case 'item.started': {
      const call = toolCall(ev.item);
      if (call) {
        state.calls.add(ev.item.id);
        yield call;
      }
      return;
    }
    case 'item.completed': {
      const item = ev.item;
      if (item.type === 'agent_message') {
        yield { type: 'message', text: text(item.text) };
        return;
      }
      if (item.type === 'error') {
        // Codex repeats config warnings once per config layer it loads.
        if (state.warnings.has(item.message)) return;
        state.warnings.add(item.message);
        yield { type: 'error', message: text(item.message), fatal: false };
        return;
      }
      // Some items (file_change) only arrive completed; emit the call first.
      if (!state.calls.has(item.id)) {
        const call = toolCall(item);
        if (call) yield call;
      }
      state.calls.delete(item.id);
      const result = toolResult(item);
      if (result) yield result;
      return;
    }
    case 'turn.completed':
      yield {
        type: 'usage',
        inputTokens: ev.usage.input_tokens,
        outputTokens: ev.usage.output_tokens,
        cachedInputTokens: ev.usage.cached_input_tokens,
        cacheWriteTokens: ev.usage.cache_write_input_tokens,
        reasoningTokens: ev.usage.reasoning_output_tokens,
      };
      yield { type: 'turn.completed' };
      return;
    case 'turn.failed':
      yield { type: 'error', message: text(ev.error.message), fatal: true };
      yield { type: 'turn.completed' };
      return;
    case 'error':
      // Stream errors include retries ("Reconnecting... 2/5"); `turn.failed` is the fatal one.
      yield { type: 'error', message: text(ev.message), fatal: false };
      return;
  }
}

export interface CodexTurn {
  input: string;
  resumeId?: string;
  options: TurnOptions;
  env: Record<string, string>;
  signal: AbortSignal;
}

export async function* runCodex(turn: CodexTurn): AsyncGenerator<RuntimeEvent> {
  const opts = codexOptions(turn.options, turn.env);
  const codex = new Codex(opts.codex);
  const thread = turn.resumeId
    ? codex.resumeThread(turn.resumeId, opts.thread)
    : codex.startThread(opts.thread);
  const { events } = await thread.runStreamed(turn.input, { signal: turn.signal });
  const state: MapState = { calls: new Set(), warnings: new Set() };
  for await (const ev of events) yield* mapCodexEvent(ev, state);
}
