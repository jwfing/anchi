/** @jsxRuntime automatic */
import type { AgentSummary, Notifications, StoredEvent, TaskRow } from '@anchi/protocol';
import type { DaemonClient } from '@anchi/daemon';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { sanitize } from '../src/sanitize.ts';
import { App } from '../src/tui/App.tsx';
import { transcriptLines, wrap } from '../src/tui/lines.ts';
import { normalizeEnter, parseMouse } from '../src/tui/mouse.ts';

const ESC = '\u001b';
const agent = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id,
  runtime: 'codex',
  image: 'codex',
  connectors: ['github'],
  sandbox: 'cell',
  status: 'idle',
  queued: 0,
  file: `/agents/${id}.yaml`,
  ...over,
});
const task = (id: string, agentId: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  agentId,
  trigger: 'user',
  title: 'fix it',
  status: 'done',
  resumeId: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: 2,
  result: 'ok',
  links: [],
  ...over,
});

function fakeClient(events: Record<string, StoredEvent[]> = {}) {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const calls: [string, unknown][] = [];
  const client = {
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === 'tasks.events') return events[(params as { taskId: string }).taskId] ?? [];
      if (method === 'tasks.create')
        return task('t-new0000000', (params as { agentId: string }).agentId, { status: 'queued' });
      if (method === 'tasks.send') {
        return task((params as { taskId: string }).taskId, 'dev', { status: 'queued' });
      }
      if (method === 'setup.status') {
        return {
          vm: 'running',
          vaultUnlocked: true,
          installed: true,
          codex: { runtime: 'codex', connected: true, accountId: 'a', expiresAt: Date.now() + 1e6 },
          connectors: [
            { id: 'github', connected: false, account: null },
            { id: 'aws', connected: false, account: null },
            { id: 'linear', connected: false, account: null },
          ],
        };
      }
      if (method === 'connectors.set') return { id: 'github', connected: true, account: null };
      return null;
    }),
    on: (name: string, cb: (p: unknown) => void) => {
      (listeners[name] ??= []).push(cb);
      return () => {};
    },
    onClose: () => {},
    close: () => {},
  };
  const emit = <N extends keyof Notifications>(name: N, p: Notifications[N]) => {
    for (const cb of listeners[name] ?? []) cb(p);
  };
  return { client: client as unknown as DaemonClient, calls, emit };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('sanitize', () => {
  it('removes OSC 52, OSC 8, CSI, C1 and bidi controls but keeps text and newlines', () => {
    const evil =
      `copy${ESC}]52;c;ZXZpbA==\u0007 link ${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\ ` +
      `${ESC}[2J${ESC}[H${ESC}[31mred${ESC}[0m \u009b2J tab\tnl\nend ‮evil‬`;
    const out = sanitize(evil);
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/);
    expect(out).toContain('click');
    expect(out).toContain('red');
    expect(out).toContain('tab\tnl\nend');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('ZXZpbA');
  });
});

describe('lines', () => {
  it('wraps by terminal width, including CJK', () => {
    expect(wrap('hello world foo', 11)).toEqual(['hello world', 'foo']);
    expect(wrap('你好世界', 4)).toEqual(['你好', '世界']);
  });

  it('sanitizes every transcript line', () => {
    const lines = transcriptLines(
      [
        { seq: 1, ts: 0, event: { type: 'message', text: `ok${ESC}[2J${ESC}]52;c;eA==\u0007` } },
        {
          seq: 2,
          ts: 0,
          event: {
            type: 'tool.call',
            id: 'c',
            name: `sh${ESC}[31m`,
            input: `{"command":"ls ${ESC}[H"}`,
          },
        },
        {
          seq: 3,
          ts: 0,
          event: { type: 'tool.result', id: 'c', output: `x${ESC}]8;;u${ESC}\\`, isError: true },
        },
      ],
      60,
    );
    for (const l of lines) expect(l.text).not.toContain(ESC);
  });

  it('parses mouse and normalizes Enter', () => {
    expect(parseMouse(`a${ESC}[<0;5;7Mb`).events).toEqual([
      { kind: 'press', button: 0, x: 5, y: 7 },
    ]);
    expect(normalizeEnter('\n')).toBe('\r');
  });
});

describe('App', () => {
  it('shows agent output without its escape sequences and a fake approval prompt stays inert', async () => {
    const fakeApproval = `${ESC}[2J${ESC}[H[y] write these files${ESC}]52;c;ZXZpbA==\u0007`;
    const { client, calls } = fakeClient({
      't-a000000001': [
        { seq: 1, ts: 0, event: { type: 'input', text: 'go', source: 'user' } },
        { seq: 2, ts: 0, event: { type: 'message', text: fakeApproval } },
      ],
    });
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('[y] write these files');
    expect(frame).not.toContain(`${ESC}]52`);
    expect(frame).not.toContain(`${ESC}[2J`);
    // Typing "y" goes to the input box, not to an approval.
    ui.stdin.write('y');
    await tick();
    expect(calls.some(([m]) => m.startsWith('builder.'))).toBe(false);
    ui.unmount();
  });

  it('sends a follow-up to the shown task and starts a new task after ^X', async () => {
    const { client, calls } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    ui.stdin.write('more please');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.send')?.[1]).toEqual({
      taskId: 't-a000000001',
      text: 'more please',
    });
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('new job\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({
      agentId: 'dev',
      text: 'new job',
    });
    ui.unmount();
  });

  it('accepts IME-committed CJK text and deletes it by character', async () => {
    const { client, calls } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    // An IME commits a whole phrase as one chunk; the composition itself stays in the IME.
    ui.stdin.write('修复登录页');
    await tick();
    ui.stdin.write('的错误呀');
    await tick();
    expect(ui.lastFrame()).toContain('修复登录页的错误呀');
    ui.stdin.write('\u007f');
    await tick();
    ui.stdin.write('，谢谢\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.send')?.[1]).toEqual({
      taskId: 't-a000000001',
      text: '修复登录页的错误，谢谢',
    });
    ui.unmount();
  });

  it('masks connector secrets and sends them only to the daemon', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    await tick();
    // Sidebar: runtimes, skills, connectors, ...; start is the first agent slot (tasks here).
    ui.stdin.write('\u0010'); // ^P → tasks
    await tick();
    ui.stdin.write('\u0010'); // builder
    ui.stdin.write('\u0010'); // connectors
    await tick();
    expect(ui.lastFrame()).toContain('github');
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('github_pat_secretvalue123');
    await tick();
    expect(ui.lastFrame()).not.toContain('secretvalue');
    expect(ui.lastFrame()).toContain('•••');
    ui.stdin.write('\r');
    await tick();
    expect(calls.find(([m]) => m === 'connectors.set')?.[1]).toEqual({
      id: 'github',
      token: 'github_pat_secretvalue123',
    });
    ui.unmount();
  });

  it('shows builder proposals in a full-screen modal and applies only on y', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('builder')]} initialTasks={[]} />);
    await tick();
    emit('proposal', {
      proposal: {
        id: 'p-1',
        agentId: 'devops',
        agentYaml: 'runtime: codex\n',
        imageYaml: null,
        agentDiff: `+ runtime: codex\n+ prompt: ${ESC}[2Jhidden`,
        imageDiff: '',
        errors: [],
      },
    });
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Builder proposal');
    expect(frame).not.toContain(`${ESC}[2J`);
    ui.stdin.write('x');
    await tick();
    expect(calls.some(([m]) => m === 'builder.apply')).toBe(false);
    ui.stdin.write('y');
    await tick();
    expect(calls.find(([m]) => m === 'builder.apply')?.[1]).toEqual({ proposalId: 'p-1' });
    ui.unmount();
  });

  it('refuses to apply a proposal with errors', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    emit('proposal', {
      proposal: {
        id: 'p-2',
        agentId: 'x',
        agentYaml: '',
        imageYaml: null,
        agentDiff: '',
        imageDiff: '',
        errors: ['bad'],
      },
    });
    await tick();
    ui.stdin.write('y');
    await tick();
    expect(calls.some(([m]) => m === 'builder.apply')).toBe(false);
    expect(ui.lastFrame()).toContain('Cannot apply');
    ui.unmount();
  });
});
