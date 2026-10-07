import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  MAX_EVENT_TEXT,
  MAX_TOOL_OUTPUT,
  type RuntimeEvent,
  truncate,
  type TurnOptions,
} from '@anchi/protocol';

export const CLAUDE_PATH = '/opt/claude/bin/claude';
/** The in-cell Anchi MCP server, as in Codex's config.toml. */
export const ANCHI_MCP = { command: '/opt/node/bin/node', args: ['/opt/anchi/mcp.mjs'] };

const text = (s: string) => truncate(s, MAX_EVENT_TEXT);

export function claudeOptions(
  options: TurnOptions,
  env: Record<string, string>,
  abortController: AbortController,
  resumeId?: string,
): Options {
  const instructions = options.instructions?.trim();
  return {
    pathToClaudeCodeExecutable: CLAUDE_PATH,
    cwd: options.workdir,
    env,
    model: options.model,
    resume: resumeId,
    abortController,
    // The cell is the boundary (D6), as with Codex's danger-full-access.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // Settings files in the work directory are agent-writable; they must not change behaviour.
    settingSources: [],
    mcpServers: { anchi: { type: 'stdio', ...ANCHI_MCP } },
    systemPrompt:
      instructions && options.instructionsMode === 'replace'
        ? instructions
        : {
            type: 'preset',
            preset: 'claude_code',
            ...(instructions ? { append: instructions } : {}),
          },
  };
}

type Block = { type: string; [key: string]: unknown };

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : `[${b.type}]`))
    .join('\n');
}

/** Maps one Agent SDK message to runtime events. */
export function* mapClaudeMessage(m: SDKMessage): Generator<RuntimeEvent> {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init')
        yield { type: 'session.started', resumeId: m.session_id.slice(0, 200) };
      return;
    case 'assistant': {
      for (const block of m.message.content as unknown as Block[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          yield { type: 'message', text: text(block.text) };
        } else if (block.type === 'tool_use') {
          yield {
            type: 'tool.call',
            id: String(block.id).slice(0, 200),
            name: String(block.name).slice(0, 200),
            input: text(JSON.stringify(block.input ?? {})),
          };
        }
      }
      if (m.error) yield { type: 'error', message: `Claude: ${m.error}`, fatal: false };
      return;
    }
    case 'user': {
      const content = (m.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return;
      for (const block of content as Block[]) {
        if (block.type !== 'tool_result') continue;
        yield {
          type: 'tool.result',
          id: String(block.tool_use_id).slice(0, 200),
          output: truncate(contentText(block.content), MAX_TOOL_OUTPUT),
          isError: block.is_error === true,
        };
      }
      return;
    }
    case 'result':
      yield {
        type: 'usage',
        inputTokens: m.usage.input_tokens,
        outputTokens: m.usage.output_tokens,
      };
      if (m.subtype !== 'success' || m.is_error) {
        const errors = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
        yield {
          type: 'error',
          message: text(`Claude stopped: ${m.subtype}${errors ? ` (${errors})` : ''}`),
          fatal: true,
        };
      }
      yield { type: 'turn.completed' };
      return;
  }
}

export interface ClaudeTurn {
  input: string;
  resumeId?: string;
  options: TurnOptions;
  env: Record<string, string>;
  signal: AbortSignal;
}

export async function* runClaude(turn: ClaudeTurn): AsyncGenerator<RuntimeEvent> {
  const controller = new AbortController();
  turn.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const messages = query({
    prompt: turn.input,
    options: claudeOptions(turn.options, turn.env, controller, turn.resumeId),
  });
  try {
    for await (const m of messages) yield* mapClaudeMessage(m);
  } catch (err) {
    // A single-shot query throws after yielding an error result, which was already mapped.
    if (!turn.signal.aborted) {
      yield { type: 'error', message: text(String((err as Error).message ?? err)), fatal: true };
    }
  }
}
