import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_EVENT_TEXT,
  MAX_TOOL_OUTPUT,
  type RuntimeEvent,
  truncate,
  type TurnOptions,
} from '@anchi/protocol';
import { ANCHI_MCP, SKILLS_PLUGIN } from './claude.ts';

/**
 * Hermes Agent, driven over ACP (JSON-RPC on the stdio of `hermes acp`). One Hermes process and
 * one ACP session serve the runner's turns; the session id is the resume id. Hermes reaches the
 * user's OpenAI-compatible endpoint with a placeholder key, which the egress proxy replaces on
 * that endpoint's base URL only.
 */

export const HERMES_PATH = '/opt/hermes/venv/bin/hermes';
/** What the egress proxy recognizes as Hermes's key (egress_rules.PLACEHOLDER_HERMES). */
export const PLACEHOLDER_KEY = 'sk-anchi-placeholder-' + '0'.repeat(40);
/** Longest JSON-RPC line read from Hermes; a session replay carries tool output. */
const MAX_LINE = 8 * 1024 * 1024;
const ACP_VERSION = 1;

const text = (s: string) => truncate(s, MAX_EVENT_TEXT);
const yamlString = (s: string) => JSON.stringify(s);

/** Hermes's config.yaml: the endpoint, and nothing that installs, updates or phones home. */
export function hermesConfig(baseUrl: string, model: string, skills: boolean): string {
  return [
    '# Written by Anchi at each start; changes here do not last.',
    'model:',
    '  provider: custom',
    `  base_url: ${yamlString(baseUrl)}`,
    `  default: ${yamlString(model)}`,
    `  api_key: ${yamlString(PLACEHOLDER_KEY)}`,
    'updates:',
    '  check: false',
    'model_catalog:',
    '  enabled: false',
    'security:',
    '  allow_lazy_installs: false',
    'approvals:',
    '  mode: "off"',
    'telemetry:',
    '  shared_metrics:',
    '    enabled: false',
    '    send: false',
    ...(skills
      ? ['skills:', '  external_dirs:', `    - ${yamlString(`${SKILLS_PLUGIN}/skills`)}`]
      : []),
    '',
  ].join('\n');
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Text of ACP tool-call content: `[{type: 'content', content: {type: 'text', text}}]`. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const inner = obj(obj(c).content);
      return inner.type === 'text' ? str(inner.text) : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A turn's state while ACP updates arrive: agent text and reasoning, flushed as whole events. */
export class HermesTurnState {
  message = '';
  thought = '';

  *flush(): Generator<RuntimeEvent> {
    if (this.thought.trim()) yield { type: 'progress', text: text(this.thought.trim()) };
    if (this.message.trim()) yield { type: 'message', text: text(this.message.trim()) };
    this.message = '';
    this.thought = '';
  }

  /** Maps one `session/update` payload (`params.update`) to runtime events. */
  *update(update: unknown): Generator<RuntimeEvent> {
    const u = obj(update);
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = obj(u.content);
        if (c.type === 'text') this.message += str(c.text);
        return;
      }
      case 'agent_thought_chunk': {
        const c = obj(u.content);
        if (c.type === 'text') this.thought += str(c.text);
        return;
      }
      case 'plan': {
        const entries = Array.isArray(u.entries) ? u.entries : [];
        const lines = entries.map((e) => {
          const entry = obj(e);
          const mark =
            entry.status === 'completed' ? '[x]' : entry.status === 'in_progress' ? '[~]' : '[ ]';
          return `${mark} ${str(entry.content)}`;
        });
        if (lines.length) yield { type: 'progress', text: text(lines.join('\n')) };
        return;
      }
      case 'tool_call': {
        yield* this.flush();
        const id = str(u.toolCallId).slice(0, 200) || 'tool';
        const input =
          u.rawInput !== undefined ? JSON.stringify(u.rawInput) : contentText(u.content);
        yield {
          type: 'tool.call',
          id,
          name: (str(u.title) || str(u.kind) || 'tool').slice(0, 200),
          input: text(input),
        };
        if (u.status === 'completed' || u.status === 'failed') yield* this.result(u);
        return;
      }
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') yield* this.result(u);
        return;
    }
  }

  private *result(u: Json): Generator<RuntimeEvent> {
    const output =
      contentText(u.content) || (u.rawOutput !== undefined ? JSON.stringify(u.rawOutput) : '');
    yield {
      type: 'tool.result',
      id: str(u.toolCallId).slice(0, 200) || 'tool',
      output: truncate(output, MAX_TOOL_OUTPUT),
      isError: u.status === 'failed',
    };
  }
}

/** Events that end a turn, from the `session/prompt` result. */
export function* promptResult(result: unknown, model: string): Generator<RuntimeEvent> {
  const r = obj(result);
  const usage = obj(r.usage);
  const n = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : undefined);
  if (Object.keys(usage).length) {
    yield {
      type: 'usage',
      model: model.slice(0, 100),
      inputTokens: n(usage.inputTokens),
      outputTokens: n(usage.outputTokens),
      cachedInputTokens: n(usage.cachedReadTokens),
      cacheWriteTokens: n(usage.cachedWriteTokens),
      reasoningTokens: n(usage.thoughtTokens),
    };
  }
  const stop = str(r.stopReason);
  if (stop && stop !== 'end_turn' && stop !== 'cancelled') {
    yield { type: 'error', message: text(`Hermes stopped: ${stop}`), fatal: false };
  }
  yield { type: 'turn.completed' };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A minimal ACP client over a child's stdio: requests, notifications, and the agent's requests. */
class AcpClient {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  onUpdate: (params: Json) => void = () => {};
  readonly exited: Promise<string>;

  constructor(private child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.data(chunk));
    // Hermes logs to stderr; keep it out of the runner's channel.
    child.stderr.resume();
    this.exited = new Promise((done) => {
      child.on('error', (err) => done(err.message));
      child.on('exit', (code, signal) => done(`Hermes exited (${signal ?? code})`));
    });
    void this.exited.then((reason) => {
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
    });
  }

  private data(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) {
      this.child.kill('SIGKILL');
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.message(line);
    }
  }

  private message(line: string) {
    let m: Json;
    try {
      m = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof m.method === 'string') {
      if (m.id !== undefined) return this.answer(m.id, m.method, obj(m.params));
      if (m.method === 'session/update') this.onUpdate(obj(m.params));
      return;
    }
    const pending = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!pending) return;
    this.pending.delete(m.id as number);
    if (m.error !== undefined) {
      const e = obj(m.error);
      pending.reject(new Error(str(e.message) || 'ACP error'));
    } else pending.resolve(m.result);
  }

  /** The agent's requests: permissions are granted (the cell is the boundary), nothing else. */
  private answer(id: unknown, method: string, params: Json) {
    if (method === 'session/request_permission') {
      const options = Array.isArray(params.options) ? params.options.map(obj) : [];
      const allow =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once');
      return this.write({
        jsonrpc: '2.0',
        id,
        result: {
          outcome: allow
            ? { outcome: 'selected', optionId: str(allow.optionId) }
            : { outcome: 'cancelled' },
        },
      });
    }
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} not supported` } });
  }

  private write(message: Json) {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: Json): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  kill() {
    this.child.kill('SIGTERM');
  }
}

export interface HermesTurn {
  input: string;
  resumeId?: string;
  options: TurnOptions;
  env: Record<string, string>;
  signal: AbortSignal;
  /** The Hermes executable; tests replace it. */
  bin?: string;
}

let client: AcpClient | undefined;
let session: string | undefined;

/** Writes Hermes's config and persona, then starts `hermes acp` and initializes it. */
async function start(turn: HermesTurn): Promise<AcpClient> {
  const home = turn.env.HERMES_HOME ?? join(turn.env.HOME ?? '/home/agent', '.hermes');
  const baseUrl = turn.env.ANCHI_HERMES_BASE_URL ?? '';
  const model = turn.options.model || turn.env.ANCHI_HERMES_MODEL || '';
  if (!baseUrl || !model) throw new Error('Hermes has no endpoint; run `anchi setup hermes`');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.yaml'), hermesConfig(baseUrl, model, existsSync(SKILLS_PLUGIN)));
  // The agent's instructions are Hermes's persona (SOUL.md); its own tool guidance stays.
  // An emptied prompt removes the file: the agent home outlives a turn, and a persona the user
  // deleted must not keep speaking.
  const soul = join(home, 'SOUL.md');
  const instructions = turn.options.instructions?.trim();
  if (instructions) writeFileSync(soul, instructions + '\n');
  else rmSync(soul, { force: true });
  const child = spawn(turn.bin ?? HERMES_PATH, ['acp'], {
    cwd: turn.options.workdir,
    env: turn.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const c = new AcpClient(child);
  void c.exited.then(() => {
    if (client === c) {
      client = undefined;
      session = undefined;
    }
  });
  await c.request('initialize', {
    protocolVersion: ACP_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'anchi', version: '1' },
  });
  return c;
}

/** The Anchi MCP server, as ACP describes a stdio server. */
const MCP_SERVERS = [{ name: 'anchi', command: ANCHI_MCP.command, args: ANCHI_MCP.args, env: [] }];

/** Continues the session `resumeId` names, or starts one; returns its id. */
async function openSession(c: AcpClient, turn: HermesTurn): Promise<string> {
  const cwd = turn.options.workdir;
  let id: string;
  if (turn.resumeId) {
    // A resume replays the session's history as updates before it answers; they were recorded
    // when they happened, so they are dropped here.
    const r = obj(
      await c.request('session/resume', { sessionId: turn.resumeId, cwd, mcpServers: MCP_SERVERS }),
    );
    const provenance = obj(obj(obj(r._meta).hermes).sessionProvenance);
    id = str(provenance.acpSessionId) || turn.resumeId;
  } else {
    id = str(obj(await c.request('session/new', { cwd, mcpServers: MCP_SERVERS })).sessionId);
    if (!id) throw new Error('Hermes did not start a session');
  }
  // No edit approvals: the cell is the boundary.
  await c.request('session/set_mode', { sessionId: id, modeId: 'dont_ask' });
  return id;
}

export async function* runHermes(turn: HermesTurn): AsyncGenerator<RuntimeEvent> {
  const queue: RuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (events: Iterable<RuntimeEvent>) => {
    for (const e of events) queue.push(e);
    wake?.();
  };
  const state = new HermesTurnState();
  let live = false;
  try {
    client ??= await start(turn);
    const c = client;
    c.onUpdate = () => {};
    if (!session) {
      session = await openSession(c, turn);
      yield { type: 'session.started', resumeId: session.slice(0, 200) };
    }
    const sessionId = session;
    c.onUpdate = (params) => {
      if (live && params.sessionId === sessionId) push(state.update(params.update));
    };
    const onAbort = () => c.notify('session/cancel', { sessionId });
    turn.signal.addEventListener('abort', onAbort, { once: true });
    live = true;
    let done = false;
    let failure: Error | undefined;
    let result: unknown;
    void c
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: turn.input }] })
      .then(
        (r) => (result = r),
        (e: Error) => (failure = e),
      )
      .finally(() => {
        done = true;
        wake?.();
      });
    while (!done || queue.length) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      wake = undefined;
      while (queue.length) yield queue.shift()!;
    }
    live = false;
    turn.signal.removeEventListener('abort', onAbort);
    yield* state.flush();
    if (failure) throw failure;
    yield* promptResult(result, turn.options.model || turn.env.ANCHI_HERMES_MODEL || '');
  } catch (err) {
    live = false;
    yield* state.flush();
    if (!turn.signal.aborted) {
      yield {
        type: 'error',
        message: text(`Hermes: ${(err as Error).message ?? err}`),
        fatal: true,
      };
    }
  }
}

/** Ends the Hermes process (the runner is closing). */
export function stopHermes(): void {
  client?.kill();
  client = undefined;
  session = undefined;
}
