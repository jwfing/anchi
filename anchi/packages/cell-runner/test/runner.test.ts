import { mkdirSync, mkdtempSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Codex, ThreadEvent } from '@openai/codex-sdk';
import {
  type CellMessage,
  cellMessageSchema,
  encodeFrame,
  type RuntimeEvent,
} from '@anchi/protocol';
import { codexOptions, mapCodexEvent, NEW_SESSION_WARNING, runCodex } from '../src/codex.ts';
import { claudeEvents, claudeOptions, mapClaudeMessage } from '../src/claude.ts';
import { callConnector, CONNECTOR_TOOLS, serviceCall } from '../src/connectors.ts';
import { handle, mcpLine, socketCall } from '../src/mcp.ts';
import { startRunner, type RunTurn } from '../src/runner.ts';

function harness(runTurn: RunTurn, toolsSocket: string | null = null) {
  const out: CellMessage[] = [];
  let data: (b: Buffer) => void = () => {};
  let end: () => void = () => {};
  const exits: number[] = [];
  startRunner(
    {
      write: (f) => out.push(cellMessageSchema.parse(JSON.parse(f))),
      onData: (cb) => (data = cb),
      onEnd: (cb) => (end = cb),
      exit: (c) => exits.push(c),
      log: () => {},
    },
    runTurn,
    'codex-cli 0.0.0',
    'codex',
    toolsSocket,
  );
  const send = (v: unknown) => data(Buffer.from(encodeFrame(v)));
  return { out, send, end: () => end(), exits };
}

const run = (turn: string, input = 'hi') => ({
  type: 'run',
  turn,
  input,
  options: { workdir: '/tmp/anchi-runner-test' },
});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('cell runner', () => {
  it('announces itself, streams events and ends turns', async () => {
    const h = harness(async function* (t) {
      yield { type: 'message', text: `echo ${t.input}` } satisfies RuntimeEvent;
    });
    expect(h.out[0]).toMatchObject({ type: 'ready', protocol: 2, runtime: 'codex' });
    h.send(run('t1', 'x'));
    await tick();
    expect(h.out.slice(1)).toEqual([
      { type: 'event', turn: 't1', event: { type: 'message', text: 'echo x' } },
      { type: 'turn.end', turn: 't1', ok: true },
    ]);
  });

  it('cancels the running turn and refuses a second concurrent turn', async () => {
    const h = harness(async function* (t) {
      await new Promise((resolve) => t.signal.addEventListener('abort', resolve));
      throw new Error('aborted');
    });
    h.send(run('t1'));
    await tick();
    h.send(run('t2'));
    await tick();
    expect(h.out.at(-1)).toEqual({ type: 'turn.end', turn: 't2', ok: false });
    h.send({ type: 'cancel', turn: 't1' });
    await tick();
    expect(h.out.at(-2)).toMatchObject({ event: { type: 'error', message: 'interrupted' } });
    expect(h.out.at(-1)).toEqual({ type: 'turn.end', turn: 't1', ok: false });
  });

  it('exits on invalid commands and on end of input', () => {
    const h = harness(async function* () {});
    h.send({ type: 'exec', command: 'sh' });
    expect(h.exits).toEqual([2]);
    const g = harness(async function* () {});
    g.end();
    expect(g.exits).toEqual([0]);
  });
});

describe('codex sessions', () => {
  const MISSING =
    'Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: no rollout found ' +
    'for thread id old (code -32600)';
  /** A fake Codex client: `resume` fails with `resumeError` after `before` events. */
  function fakeCodex(resumeError: string, before: ThreadEvent[] = []) {
    const calls: string[] = [];
    const thread = (kind: string, events: ThreadEvent[], error?: string) => ({
      runStreamed: async (input: string) => {
        calls.push(`${kind}:${input}`);
        return {
          events: (async function* () {
            yield* events;
            if (error) throw new Error(error);
          })(),
        };
      },
    });
    const client = {
      resumeThread: () => thread('resume', before, resumeError),
      startThread: () =>
        thread('start', [
          { type: 'thread.started', thread_id: 'new' },
          { type: 'turn.completed', usage: USAGE },
        ]),
    } as unknown as Pick<Codex, 'startThread' | 'resumeThread'>;
    return { client: () => client, calls };
  }
  const USAGE = {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };
  const turn = {
    input: 'hi',
    resumeId: 'old',
    options: { workdir: '/w', sandbox: 'cell' as const, instructionsMode: 'append' as const },
    env: {},
    signal: new AbortController().signal,
  };
  const collect = async (gen: AsyncGenerator<RuntimeEvent>) => {
    const out: RuntimeEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  };

  it('starts a new session with a warning when the session to resume is gone', async () => {
    const fake = fakeCodex(MISSING);
    const events = await collect(runCodex(turn, fake.client));
    expect(fake.calls).toEqual(['resume:hi', 'start:hi']);
    expect(events[0]).toEqual({ type: 'error', message: NEW_SESSION_WARNING, fatal: false });
    expect(events).toContainEqual({ type: 'session.started', resumeId: 'new' });
    expect(events.some((e) => e.type === 'error' && e.fatal)).toBe(false);
  });

  it('does not start a new session for other failures or once the turn has begun', async () => {
    const other = fakeCodex('Codex Exec exited with code 1: usage limit reached');
    await expect(collect(runCodex(turn, other.client))).rejects.toThrow(/usage limit/);
    expect(other.calls).toEqual(['resume:hi']);
    const begun = fakeCodex(MISSING, [{ type: 'turn.started' }]);
    await expect(collect(runCodex(turn, begun.client))).rejects.toThrow(/no rollout/);
    expect(begun.calls).toEqual(['resume:hi']);
  });
});

describe('codex mapping', () => {
  it('maps the cell sandbox to danger-full-access and the opt-in to workspace-write', () => {
    const base = { workdir: '/home/agent/work', instructionsMode: 'append' as const };
    expect(codexOptions({ ...base, sandbox: 'cell' }, {}).thread.sandboxMode).toBe(
      'danger-full-access',
    );
    const opt = codexOptions(
      { ...base, sandbox: 'codex-workspace-write', instructions: 'be brief' },
      {},
    );
    expect(opt.thread.sandboxMode).toBe('workspace-write');
    expect(opt.codex.config).toEqual({
      features: { apps: false, plugins: false },
      developer_instructions: 'be brief',
    });
    expect(opt.codex.codexPathOverride).toBe('/opt/codex/bin/codex');
  });

  it('truncates tool output and stringifies tool input within protocol limits', () => {
    const state = { calls: new Set<string>(), warnings: new Set<string>() };
    const events = [
      ...mapCodexEvent(
        {
          type: 'item.completed',
          item: {
            id: 'c1',
            type: 'command_execution',
            command: 'yes',
            aggregated_output: 'y\n'.repeat(100_000),
            exit_code: 0,
            status: 'completed',
          },
        },
        state,
      ),
    ];
    for (const e of events) {
      expect(cellMessageSchema.safeParse({ type: 'event', turn: 't', event: e }).success).toBe(
        true,
      );
    }
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.result']);
  });

  it('reports Codex reasoning summaries and changed plans as progress', () => {
    const state = { calls: new Set<string>(), warnings: new Set<string>() };
    const todo = (completed: boolean) => ({
      id: 't1',
      type: 'todo_list' as const,
      items: [
        { text: 'read', completed: true },
        { text: 'fix', completed },
      ],
    });
    const events = [
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: '**Reading**' } },
      { type: 'item.completed', item: { id: 'r2', type: 'reasoning', text: '  ' } },
      { type: 'item.started', item: todo(false) },
      { type: 'item.updated', item: todo(false) },
      { type: 'item.updated', item: todo(true) },
      { type: 'item.completed', item: todo(true) },
    ].flatMap((ev) => [...mapCodexEvent(ev as never, state)]);
    expect(events).toEqual([
      { type: 'progress', text: '**Reading**' },
      { type: 'progress', text: 'Plan: ✓ read · ○ fix' },
      { type: 'progress', text: 'Plan: ✓ read · ✓ fix' },
    ]);
    for (const e of events) {
      expect(cellMessageSchema.safeParse({ type: 'event', turn: 't', event: e }).success).toBe(
        true,
      );
    }
  });

  it('reports cached, cache-write and reasoning tokens of a Codex turn', () => {
    const state = { calls: new Set<string>(), warnings: new Set<string>() };
    const events = [
      ...mapCodexEvent(
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 1200,
            cached_input_tokens: 800,
            cache_write_input_tokens: 0,
            output_tokens: 90,
            reasoning_output_tokens: 40,
          },
        } as never,
        state,
      ),
    ];
    expect(events[0]).toEqual({
      type: 'usage',
      inputTokens: 1200,
      outputTokens: 90,
      cachedInputTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 40,
    });
    expect(
      cellMessageSchema.safeParse({ type: 'event', turn: 't', event: events[0] }).success,
    ).toBe(true);
  });
});

describe('tool relay', () => {
  it('relays MCP tool calls of the running turn to the daemon and back', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'anchi-tools-')), 'tools.sock');
    let release: () => void = () => {};
    const h = harness(async function* () {
      await new Promise<void>((r) => (release = r));
      yield { type: 'message', text: 'done' };
    }, socket);
    const ask = (req: unknown) =>
      new Promise<unknown>((resolve) => {
        const conn = createConnection(socket, () => conn.write(`${JSON.stringify(req)}\n`));
        conn.on('data', (d) => {
          resolve(JSON.parse(d.toString('utf8')));
          conn.end();
        });
      });
    await new Promise((r) => setTimeout(r, 20));
    // No turn yet: refused without reaching the daemon.
    expect(await ask({ tool: 'anchi_whoami', args: {} })).toEqual({
      ok: false,
      error: 'no turn is running',
    });
    h.send({ type: 'run', turn: 't1', input: 'go', options: { workdir: tmpdir() } });
    await new Promise((r) => setTimeout(r, 20));
    expect(await ask({ tool: 'Bad Name', args: {} })).toMatchObject({ ok: false });
    const answer = ask({ tool: 'anchi_whoami', args: { x: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    const req = h.out.find((m) => m.type === 'tool.request');
    expect(req).toMatchObject({ turn: 't1', tool: 'anchi_whoami', args: { x: 1 } });
    h.send({
      type: 'tool.response',
      id: (req as { id: string }).id,
      ok: true,
      result: { agent: 'dev' },
    });
    expect(await answer).toEqual({ ok: true, result: { agent: 'dev' } });
    release();
    h.end();
  });
});

describe('MCP server', () => {
  it('lists and calls Anchi tools through the runner', async () => {
    const calls: [string, unknown][] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      calls.push([tool, args]);
      if (tool === 'anchi.tools')
        return { ok: true, result: { tools: [{ name: 'anchi_whoami' }] } };
      if (tool === 'anchi_whoami') return { ok: true, result: { agent: 'dev' } };
      return { ok: false, error: 'unknown tool nope' };
    };
    const init = await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      call,
    );
    expect(init).toMatchObject({
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
    });
    expect(
      await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, call),
    ).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, call)).toMatchObject({
      result: { tools: [{ name: 'anchi_whoami' }] },
    });
    expect(
      await handle(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'anchi_whoami', arguments: {} },
        },
        call,
      ),
    ).toMatchObject({ result: { isError: false, structuredContent: { agent: 'dev' } } });
    expect(
      await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, call),
    ).toMatchObject({ result: { isError: true, content: [{ text: 'unknown tool nope' }] } });
    expect(await handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, call)).toMatchObject({
      error: { code: -32601 },
    });
  });
});

describe('sockets that close without answering', () => {
  /** A peer that reads the request and hangs up: a restarted service, a runner that went away. */
  const silent = async (path: string) => {
    const server = createServer((conn) => conn.once('data', () => conn.end()));
    await new Promise<void>((r) => server.listen(path, r));
    return () => new Promise<void>((r) => server.close(() => r()));
  };

  it('fails a connector call at once instead of hanging the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchi-silent-'));
    const close = await silent(join(dir, 'x.sock'));
    try {
      await expect(serviceCall(join(dir, 'x.sock'), { op: 'list' })).rejects.toThrow(
        'CONNECTOR_CLOSED',
      );
    } finally {
      await close();
    }
  });

  it('tells the agent that a write may have happened when the service hung up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchi-silent-'));
    mkdirSync(join(dir, 'notion'));
    const close = await silent(join(dir, 'notion/api.sock'));
    const tool = CONNECTOR_TOOLS.find((t) => t.name === 'notion_append')!;
    try {
      await expect(
        callConnector(tool, { page_id: 'p', paragraphs: ['a'] }, { call: serviceCall, dir }),
      ).rejects.toThrow(/closed the connection without answering; the write may or may not/);
    } finally {
      await close();
    }
  });

  it('answers the MCP tool call instead of hanging it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchi-silent-'));
    const close = await silent(join(dir, 'tools.sock'));
    try {
      expect(await socketCall(join(dir, 'tools.sock'))('anchi_whoami', {})).toEqual({
        ok: false,
        error: 'Anchi closed the connection',
      });
    } finally {
      await close();
    }
  });
});

describe('MCP server robustness', () => {
  it('keeps serving after a line that is not a request or a handler that throws', async () => {
    const out: Record<string, unknown>[] = [];
    const write = (m: Record<string, unknown>) => void out.push(m);
    const call = async () => {
      throw new Error('boom');
    };
    await mcpLine('null', call, write);
    await mcpLine('42', call, write);
    await mcpLine('[1]', call, write);
    await mcpLine('{"jsonrpc":"2.0","id":7,"method":"tools/list"}', call, write);
    await mcpLine('{"jsonrpc":"2.0","method":"tools/list"}', call, write);
    await mcpLine('{"jsonrpc":"2.0","id":8,"method":"ping"}', call, write);
    expect(out).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
      { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'internal error: boom' } },
      { jsonrpc: '2.0', id: 8, result: {} },
    ]);
  });
});

describe('Claude Code mapping', () => {
  it('reports a failing single-shot query once', async () => {
    const result = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: { input_tokens: 1, output_tokens: 2 },
      errors: ['boom'],
    };
    async function* failing() {
      yield result as never;
      throw new Error('Claude Code process exited with code 1');
    }
    const events = [];
    for await (const e of claudeEvents(failing(), new AbortController().signal)) events.push(e);
    expect(events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', message: 'Claude stopped: error_during_execution (boom)', fatal: true },
    ]);
    // A query that throws before any result is still reported.
    // eslint-disable-next-line require-yield
    async function* crashing() {
      throw new Error('spawn failed');
    }
    const only = [];
    for await (const e of claudeEvents(crashing(), new AbortController().signal)) only.push(e);
    expect(only).toEqual([{ type: 'error', message: 'spawn failed', fatal: true }]);
  });

  it('maps SDK messages to runtime events', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'List the files first.' },
            { type: 'text', text: 'Running it.' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'a.txt' }] },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['too many turns'],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        usage: { input_tokens: 3, output_tokens: 2 },
        modelUsage: {
          'claude-opus-5-5': {
            inputTokens: 30,
            outputTokens: 20,
            cacheReadInputTokens: 500,
            cacheCreationInputTokens: 40,
            thinkingTokens: 5,
            costUSD: 0.12,
          },
          'claude-haiku-4-5': {
            inputTokens: 7,
            outputTokens: 3,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.001,
          },
        },
      },
    ].flatMap((m) => [...mapClaudeMessage(m as never)]);
    expect(events).toEqual([
      { type: 'session.started', resumeId: 'sess-1' },
      { type: 'progress', text: 'List the files first.' },
      { type: 'message', text: 'Running it.' },
      { type: 'tool.call', id: 'tu1', name: 'Bash', input: '{"command":"ls"}' },
      { type: 'tool.result', id: 'tu1', output: 'a.txt', isError: false },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'turn.completed' },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'error', message: 'Claude stopped: error_max_turns (too many turns)', fatal: true },
      { type: 'turn.completed' },
      {
        type: 'usage',
        model: 'claude-opus-5-5',
        inputTokens: 30,
        outputTokens: 20,
        cachedInputTokens: 500,
        cacheWriteTokens: 40,
        reasoningTokens: 5,
        costUsd: 0.12,
        cumulative: true,
      },
      {
        type: 'usage',
        model: 'claude-haiku-4-5',
        inputTokens: 7,
        outputTokens: 3,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: undefined,
        costUsd: 0.001,
        cumulative: true,
      },
      { type: 'turn.completed' },
    ]);
  });

  it('bypasses permissions inside the cell and loads no settings files', () => {
    const o = claudeOptions(
      {
        workdir: '/home/agent/work',
        instructions: 'Be brief',
        instructionsMode: 'append',
        sandbox: 'cell',
      },
      {},
      new AbortController(),
      'sess-1',
    );
    expect(o).toMatchObject({
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      permissionMode: 'bypassPermissions',
      settingSources: [],
      resume: 'sess-1',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be brief' },
      mcpServers: { anchi: { type: 'stdio', args: ['/opt/anchi/mcp.mjs'] } },
    });
  });
});

describe('connector tools', () => {
  it('offers bounded X tools and keeps a post request stable while approval is pending', async () => {
    const names = CONNECTOR_TOOLS.filter((t) => t.connector === 'x').map((t) => t.name);
    expect(names).toEqual(['x_read', 'x_search', 'x_mentions', 'x_post']);
    const tool = CONNECTOR_TOOLS.find((t) => t.name === 'x_post')!;
    const requests: Record<string, unknown>[] = [];
    await callConnector(
      tool,
      { text: 'hello', reply_to: '123', account_id: 'forged' },
      {
        call: async (path, request) => {
          expect(path).toBe('/run/anchi/connectors/x/api.sock');
          requests.push({ ...request });
          if (requests.length === 1) throw new Error('APPROVAL_REQUIRED:' + 'a'.repeat(32));
          return { id: '456' };
        },
        wait: async () => {},
      },
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ op: 'post', text: 'hello', reply_to: '123' });
    expect(requests[0]).not.toHaveProperty('account_id');
  });
  it('offers bounded Reddit tools and keeps a comment request stable while approval is pending', async () => {
    const names = CONNECTOR_TOOLS.filter((t) => t.connector === 'reddit').map((t) => t.name);
    expect(names).toEqual([
      'reddit_list',
      'reddit_search',
      'reddit_read',
      'reddit_comments',
      'reddit_submit',
      'reddit_comment',
    ]);
    const tool = CONNECTOR_TOOLS.find((t) => t.name === 'reddit_comment')!;
    const requests: Record<string, unknown>[] = [];
    await callConnector(
      tool,
      { text: 'hello', parent: 't3_abc', account_id: 'forged' },
      {
        call: async (path, request) => {
          expect(path).toBe('/run/anchi/connectors/reddit/api.sock');
          requests.push({ ...request });
          if (requests.length === 1) throw new Error('APPROVAL_REQUIRED:' + 'a'.repeat(32));
          return { id: '456' };
        },
        wait: async () => {},
      },
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).toMatchObject({ op: 'comment', text: 'hello', parent: 't3_abc' });
    expect(requests[0]).not.toHaveProperty('account_id');
  });
  it('keeps one request id while a write waits for approval', async () => {
    const tool = CONNECTOR_TOOLS.find((t) => t.name === 'notion_create_page')!;
    const requests: Record<string, unknown>[] = [];
    const announced: string[] = [];
    let n = 0;
    const result = await callConnector(
      tool,
      { parent_page_id: 'p1', title: 'Notes', paragraphs: ['a'], extra: 'dropped' },
      {
        call: async (path, request) => {
          expect(path).toBe('/run/anchi/connectors/notion/api.sock');
          requests.push(request);
          if (++n < 3) throw new Error('APPROVAL_REQUIRED:' + 'f'.repeat(32));
          return { page_id: 'new' };
        },
        onApproval: (id) => announced.push(id),
        wait: async () => {},
      },
    );
    expect(result).toEqual({ page_id: 'new' });
    expect(new Set(requests.map((r) => r.request_id)).size).toBe(1);
    expect(requests[0]).toMatchObject({ op: 'create_page', title: 'Notes', paragraphs: ['a'] });
    expect(requests[0]).not.toHaveProperty('extra');
    expect(announced).toEqual(['f'.repeat(32)]);
  });

  it('reads carry no request id and other errors are not retried', async () => {
    const tool = CONNECTOR_TOOLS.find((t) => t.name === 'gmail_list')!;
    await expect(
      callConnector(
        tool,
        { query: 'x', limit: 1 },
        {
          call: async (_p, request) => {
            expect(request).toEqual({ op: 'list', query: 'x', limit: 1 });
            throw new Error('POLICY_DENIED');
          },
        },
      ),
    ).rejects.toThrow('POLICY_DENIED');
  });
});
