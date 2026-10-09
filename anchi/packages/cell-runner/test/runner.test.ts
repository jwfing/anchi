import { mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CellMessage,
  cellMessageSchema,
  encodeFrame,
  type RuntimeEvent,
} from '@anchi/protocol';
import { codexOptions, mapCodexEvent } from '../src/codex.ts';
import { claudeOptions, mapClaudeMessage } from '../src/claude.ts';
import { callConnector, CONNECTOR_TOOLS } from '../src/connectors.ts';
import { handle } from '../src/mcp.ts';
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
    expect(opt.codex.config).toEqual({ developer_instructions: 'be brief' });
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

describe('Claude Code mapping', () => {
  it('maps SDK messages to runtime events', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
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
