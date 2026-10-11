import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@anchi/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  hermesConfig,
  HermesTurnState,
  PLACEHOLDER_KEY,
  promptResult,
  runHermes,
  stopHermes,
} from '../src/hermes.ts';

const FAKE = join(import.meta.dirname, 'fixtures/fake-hermes.mjs');

describe('Hermes event mapping', () => {
  it('turns ACP updates into whole messages, reasoning, tool calls and results', () => {
    const s = new HermesTurnState();
    const events = [
      ...s.update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Plan ' },
      }),
      ...s.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Let me ' },
      }),
      ...s.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'look.' },
      }),
      ...s.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'terminal: ls',
        kind: 'execute',
        rawInput: { command: 'ls' },
      }),
      ...s.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }],
      }),
      ...s.update({
        sessionUpdate: 'plan',
        entries: [
          { content: 'read', status: 'completed' },
          { content: 'fix', status: 'in_progress' },
        ],
      }),
      ...s.update({ sessionUpdate: 'usage_update', size: 1, used: 1 }),
      ...s.update('not an object'),
      ...s.flush(),
    ];
    expect(events).toEqual([
      { type: 'progress', text: 'Plan' },
      { type: 'message', text: 'Let me look.' },
      { type: 'tool.call', id: 'tc-1', name: 'terminal: ls', input: '{"command":"ls"}' },
      { type: 'tool.result', id: 'tc-1', output: 'no such file', isError: true },
      { type: 'progress', text: '[x] read\n[~] fix' },
    ]);
  });

  it('reports usage and stop reasons at the end of a turn', () => {
    expect([
      ...promptResult(
        { stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 2, thoughtTokens: 1 } },
        'm',
      ),
    ]).toEqual([
      {
        type: 'usage',
        model: 'm',
        inputTokens: 5,
        outputTokens: 2,
        cachedInputTokens: undefined,
        cacheWriteTokens: undefined,
        reasoningTokens: 1,
      },
      { type: 'error', message: 'Hermes stopped: max_tokens', fatal: false },
      { type: 'turn.completed' },
    ]);
    expect([...promptResult({ stopReason: 'cancelled' }, 'm')]).toEqual([
      { type: 'turn.completed' },
    ]);
  });

  it('writes a config with the endpoint, a placeholder key and nothing that phones home', () => {
    const config = hermesConfig('https://openrouter.ai/api/v1', 'a/b', true);
    expect(config).toContain('provider: custom');
    expect(config).toContain('base_url: "https://openrouter.ai/api/v1"');
    expect(config).toContain(`api_key: "${PLACEHOLDER_KEY}"`);
    expect(config).toMatch(/updates:\n {2}check: false/);
    expect(config).toMatch(/allow_lazy_installs: false/);
    expect(config).toContain('"/opt/anchi-skills/skills"');
    expect(hermesConfig('https://x.example/v1', 'm', false)).not.toContain('external_dirs');
    // A model name cannot break out of its YAML string.
    expect(hermesConfig('https://x.example/v1', 'm"\nevil: true', false)).not.toMatch(/^evil:/m);
  });
});

describe('Hermes over ACP', () => {
  let dir: string;
  let log: string;

  beforeAll(() => chmodSync(FAKE, 0o755));
  afterEach(() => stopHermes());

  const turn = (
    input: string,
    extra: { resumeId?: string; signal?: AbortSignal; instructions?: string } = {},
  ) => {
    dir = dir ?? mkdtempSync(join(tmpdir(), 'hermes-'));
    log = join(dir, 'acp.log');
    return runHermes({
      input,
      resumeId: extra.resumeId,
      options: {
        workdir: dir,
        instructions: extra.instructions ?? 'You review code.',
        instructionsMode: 'append',
        sandbox: 'cell',
      },
      env: {
        ...process.env,
        HOME: dir,
        HERMES_HOME: join(dir, '.hermes'),
        ANCHI_HERMES_BASE_URL: 'https://openrouter.ai/api/v1',
        ANCHI_HERMES_MODEL: 'nousresearch/hermes-4-405b',
        FAKE_HERMES_LOG: join(dir, 'acp.log'),
      } as Record<string, string>,
      signal: extra.signal ?? new AbortController().signal,
      bin: FAKE,
    });
  };
  const collect = async (it: AsyncIterable<RuntimeEvent>) => {
    const out: RuntimeEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };
  const requests = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });

  it('starts a session with the Anchi MCP server, runs turns in it and records usage', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-'));
    const first = await collect(turn('first'));
    expect(first).toEqual([
      { type: 'session.started', resumeId: 's-1' },
      { type: 'progress', text: 'Thinking about echo.' },
      {
        type: 'tool.call',
        id: 'tc-1',
        name: 'terminal: echo hello-from-tool',
        input: '$ echo hello-from-tool',
      },
      {
        type: 'tool.result',
        id: 'tc-1',
        output: 'terminal result\n- **output:** hello-from-tool',
        isError: false,
      },
      { type: 'message', text: 'Done: first.' },
      {
        type: 'usage',
        model: 'nousresearch/hermes-4-405b',
        inputTokens: 22,
        outputTokens: 14,
        cachedInputTokens: 3,
        cacheWriteTokens: undefined,
        reasoningTokens: 2,
      },
      { type: 'turn.completed' },
    ]);
    // The second turn continues the same process and session.
    const second = await collect(turn('second'));
    expect(second[0]).toEqual({ type: 'progress', text: 'Thinking about echo.' });
    const sent = requests();
    expect(sent.filter((m) => m.method === 'session/new')).toHaveLength(1);
    expect(sent.find((m) => m.method === 'session/new')!.params!.mcpServers).toEqual([
      { name: 'anchi', command: '/opt/node/bin/node', args: ['/opt/anchi/mcp.mjs'], env: [] },
    ]);
    expect(sent.find((m) => m.method === 'session/set_mode')!.params!.modeId).toBe('dont_ask');
    const config = readFileSync(join(dir, '.hermes/config.yaml'), 'utf8');
    expect(config).toContain('default: "nousresearch/hermes-4-405b"');
    expect(readFileSync(join(dir, '.hermes/SOUL.md'), 'utf8')).toBe('You review code.\n');
  });

  it('drops the persona when the agent prompt is cleared', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-'));
    await collect(turn('first'));
    const soul = join(dir, '.hermes/SOUL.md');
    expect(readFileSync(soul, 'utf8')).toBe('You review code.\n');
    // The agent home outlives the turn; a prompt the user emptied leaves no SOUL.md behind.
    stopHermes();
    await collect(turn('second', { instructions: '  ' }));
    expect(existsSync(soul)).toBe(false);
  });

  it('resumes a session without repeating its history', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-'));
    const events = await collect(turn('again', { resumeId: 's-known' }));
    expect(events[0]).toEqual({ type: 'session.started', resumeId: 's-known' });
    expect(events.filter((e) => e.type === 'message')).toEqual([
      { type: 'message', text: 'Done: again.' },
    ]);
  });

  it('grants the permissions Hermes asks for: the cell is the boundary', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-'));
    const events = await collect(turn('ask'));
    expect(events).toContainEqual({ type: 'message', text: 'permission allow_session' });
  });

  it('reports a Hermes that exits as a fatal error, and starts a new one next turn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-'));
    const crashed = await collect(turn('crash'));
    expect(crashed.at(-1)).toMatchObject({ type: 'error', fatal: true });
    expect((crashed.at(-1) as { message: string }).message).toMatch(/Hermes exited/);
    const next = await collect(turn('after'));
    expect(next).toContainEqual({ type: 'message', text: 'Done: after.' });
  });
});
