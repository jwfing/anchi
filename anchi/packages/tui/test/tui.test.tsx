/** @jsxRuntime automatic */
import type {
  AgentSettings,
  AgentSummary,
  Notifications,
  RuntimeEvent,
  StoredEvent,
  TaskRow,
} from '@anchi/protocol';
import type { DaemonClient } from '@anchi/daemon';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { TerminalRenderer } from '../src/render.ts';
import { sanitize } from '../src/sanitize.ts';
import { nextSetupAction, teamActivity, turnActivity, welcomeStep } from '../src/tui/usability.ts';
import { App, filterTasks } from '../src/tui/App.tsx';
import { buildKeyMap } from '../src/tui/keys.ts';
import { transcriptLines, wrap } from '../src/tui/lines.ts';
import { type MouseEvent, normalizeEnter, parseMouse } from '../src/tui/mouse.ts';

const ESC = '\u001b';
const agent = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id,
  runtime: 'codex',
  image: 'codex',
  connectors: ['github'],
  sandbox: 'cell',
  status: 'idle',
  running: 0,
  queued: 0,
  maxTasks: 3,
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
  parentId: null,
  rootId: id,
  depth: 0,
  turns: 1,
  inputTokens: 0,
  outputTokens: 0,
  ...over,
});

function fakeClient(
  events: Record<string, StoredEvent[]> = {},
  answers: Record<string, (params: unknown) => unknown> = {},
) {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const calls: [string, unknown][] = [];
  const client = {
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (answers[method]) return answers[method]!(params);
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
/** Waits until the frame shows `text` (renders that follow an effect can lag one tick on CI). */
async function frameWith(ui: { lastFrame: () => string | undefined }, text: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(ui.lastFrame() ?? '').includes(text) && Date.now() < deadline) await tick(10);
  return ui.lastFrame() ?? '';
}

/** From an agent's view: to the sidebar, the Tasks section, down `index` tasks, and open it. */
async function openTask(ui: { stdin: { write: (s: string) => void } }, index = 0) {
  ui.stdin.write('\u001b'); // Esc with an empty draft: the sidebar
  await tick();
  ui.stdin.write('3'); // the first task
  await tick();
  for (let i = 0; i < index; i++) {
    ui.stdin.write('j');
    await tick();
  }
  ui.stdin.write('\r'); // open it: its view, with an input
  await tick();
}

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
      { verbose: true },
    );
    for (const l of lines) expect(l.text).not.toContain(ESC);
  });

  it('folds a run of tool calls into one line that expands', () => {
    const call = (seq: number, command: string): StoredEvent => ({
      seq,
      ts: 0,
      event: {
        type: 'tool.call',
        id: `c${seq}`,
        name: 'shell',
        input: JSON.stringify({ command }),
      },
    });
    const result = (seq: number, isError = false): StoredEvent => ({
      seq,
      ts: 0,
      event: { type: 'tool.result', id: `c${seq - 1}`, output: 'out', isError },
    });
    const events: StoredEvent[] = [
      { seq: 1, ts: 0, event: { type: 'input', text: 'fix it', source: 'user' } },
      call(2, 'ls'),
      result(3),
      call(4, 'git status'),
      result(5, true),
      { seq: 6, ts: 0, event: { type: 'message', text: 'Looking further.' } },
      call(7, "/bin/bash -lc 'make test'"),
    ];
    const text = (ls: { text: string }[]) => ls.map((l) => l.text);
    // Running: the last group is one line with the latest call.
    const live = transcriptLines(events, 80, { live: true, prefix: 't:' });
    expect(text(live)).toEqual([
      '› fix it',
      '▸ 2 tool calls (1 failed) · last: shell git status · click to expand',
      'Looking further.',
      '▸ 1 tool call · shell make test',
    ]);
    expect(live[1]!.group).toBe('t:g2');
    // Done and expanded: the full list under a header.
    const open = transcriptLines(events, 80, { expanded: new Set(['t:g2']), prefix: 't:' });
    expect(text(open).slice(1, 6)).toEqual([
      '▾ 2 tool calls (1 failed)',
      '▸ shell ls',
      '  ⎿ out',
      '▸ shell git status',
      '  ⎿ out',
    ]);
    expect(text(open).at(-1)).toBe('▸ 1 tool call · last: shell make test · click to expand');
  });

  it('shows progress only in the verbose transcript, and the latest on the working line', () => {
    const events: StoredEvent[] = [
      { seq: 1, ts: 0, event: { type: 'input', text: 'build an agent', source: 'user' } },
      { seq: 2, ts: 0, event: { type: 'progress', text: '**Choosing connectors**\n\ndetail' } },
    ];
    expect(transcriptLines(events, 80).map((l) => l.text)).toEqual(['› build an agent']);
    expect(transcriptLines(events, 80, { verbose: true }).map((l) => l.text)).toContain(
      '✻ **Choosing connectors**',
    );
    expect(turnActivity(events)).toBe('Choosing connectors');
    expect(turnActivity(events.slice(0, 1))).toBe('thinking…');
    const call: StoredEvent = {
      seq: 3,
      ts: 0,
      event: { type: 'tool.call', id: 'c', name: 'shell', input: '{"command":"ls"}' },
    };
    expect(turnActivity([...events, call])).toBe('shell ls');
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
        initialTasks={[task('t-a000000001', 'dev', { status: 'running' })]}
      />,
    );
    await tick();
    await openTask(ui);
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

  it("starts a task with each message in the agent's view, and replies in the task's view", async () => {
    const { client, calls } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev', { title: 'earlier job' })]}
      />,
    );
    await tick();
    // The agent's view lists its tasks; a message starts another one.
    expect(ui.lastFrame()).toContain('t-a000000001  earlier job');
    expect(ui.lastFrame()).toContain('New task for @dev · 0 running · 0 queued (up to 3 at once)');
    ui.stdin.write('new job\r');
    await tick();
    expect(calls.filter(([m]) => m === 'tasks.create').map(([, p]) => p)).toEqual([
      { agentId: 'dev', text: 'new job' },
    ]);
    expect(calls.some(([m]) => m === 'tasks.send')).toBe(false);
    // The task's own view replies to it.
    await openTask(ui, 1);
    expect(ui.lastFrame()).toContain('Reply to t-a000000001');
    ui.stdin.write('more please\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.send')?.[1]).toEqual({
      taskId: 't-a000000001',
      text: 'more please',
    });
    // ^X n goes back to the agent's view for a new task.
    ui.stdin.write('\u0018');
    await tick();
    expect(ui.lastFrame()).toContain('New task for this agent (from a task');
    ui.stdin.write('n');
    expect(await frameWith(ui, 'New task for @dev')).toContain(
      'each message here starts a new task',
    );
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
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({
      agentId: 'dev',
      text: '修复登录页的错误，谢谢',
    });
    ui.unmount();
  });

  it('masks connector secrets and sends them only to the daemon', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    await tick();
    // Sidebar: runtimes, skills, connectors, usage, access, builder, agents, tasks; no agents, so the builder.
    ui.stdin.write('\u0010'); // ^P → access
    ui.stdin.write('\u0010'); // ^P → usage
    ui.stdin.write('\u0010'); // ^P → connectors
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

  it('shows Gmail as waiting for sign-in once the Google client is stored', async () => {
    const service = (id: string) => ({
      id,
      connected: false,
      account: null,
      reauthRequired: false,
      mode: 'auto',
    });
    const { client } = fakeClient(
      {},
      {
        'setup.status': () => ({
          vm: 'running',
          vaultUnlocked: true,
          installed: true,
          codex: { runtime: 'codex', connected: true, accountId: 'a', expiresAt: Date.now() + 1e6 },
          connectors: [{ id: 'github', connected: false, account: null }],
          services: [service('gmail'), service('drive'), service('notion')],
          googleClient: true,
        }),
      },
    );
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    await tick();
    ui.stdin.write('\u0010'); // ^P → access
    ui.stdin.write('\u0010'); // ^P → usage
    ui.stdin.write('\u0010'); // ^P → connectors
    const frame = await frameWith(ui, 'SERVICES');
    expect(frame).toMatch(/gmail +client stored — press Enter to sign in/);
    expect(frame).toMatch(/drive +client stored — press Enter to sign in/);
    expect(frame).toMatch(/notion +not connected/);
    ui.unmount();
  });

  it('lists named Google accounts and disconnects the one chosen', async () => {
    const account = (name: string, label: string) => ({
      name,
      connected: true,
      account: label,
      reauthRequired: false,
      revocationPending: false,
    });
    const { client, calls } = fakeClient(
      {},
      {
        'setup.status': () => ({
          vm: 'running',
          vaultUnlocked: true,
          installed: true,
          codex: { runtime: 'codex', connected: true, accountId: 'a', expiresAt: Date.now() + 1e6 },
          connectors: [{ id: 'github', connected: false, account: null }],
          services: [
            {
              id: 'gmail',
              connected: true,
              account: 'me@home.example',
              reauthRequired: false,
              mode: 'auto',
              accounts: [account('default', 'me@home.example'), account('work', 'me@work.example')],
            },
          ],
          googleClient: true,
          googleClientSource: 'builtin',
        }),
      },
    );
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    await tick();
    ui.stdin.write('\u0010'); // ^P → access
    ui.stdin.write('\u0010'); // ^P → usage
    ui.stdin.write('\u0010'); // ^P → connectors
    const frame = await frameWith(ui, 'me@work.example');
    expect(frame).toContain('Google client (Gmail, Drive): built-in');
    expect(frame).toMatch(/└ work +me@work\.example/);
    for (let i = 0; i < 3; i++) {
      ui.stdin.write('j'); // github, aws, linear → gmail
      await tick();
    }
    ui.stdin.write('d');
    const dialog = await frameWith(ui, 'Disconnect a gmail account');
    expect(dialog.replace(/[\s║]+/g, ' ')).toContain('work (me@work.example)');
    ui.stdin.write('work');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(calls.find(([m]) => m === 'services.disconnect')?.[1]).toEqual({
      id: 'gmail',
      account: 'work',
    });
    ui.unmount();
  });

  it('expands tool calls on click and with ^X t', async () => {
    const events = {
      't-a000000001': [
        {
          seq: 1,
          ts: 0,
          event: { type: 'tool.call', id: 'a', name: 'shell', input: '{"command":"ls"}' },
        },
        {
          seq: 2,
          ts: 0,
          event: { type: 'tool.call', id: 'b', name: 'shell', input: '{"command":"pwd"}' },
        },
        { seq: 3, ts: 0, event: { type: 'message', text: 'done' } },
      ] as StoredEvent[],
    };
    const { client } = fakeClient(events);
    let mouse: ((e: MouseEvent) => void) | undefined;
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
        onMouse={(h) => (mouse = h)}
      />,
    );
    await tick();
    await openTask(ui);
    ui.stdin.write('\u0018'); // ^X h: the transcript instead of the result
    await tick();
    ui.stdin.write('h');
    await tick();
    expect(ui.lastFrame()).toContain('2 tool calls');
    expect(ui.lastFrame()).not.toContain('shell pwd\n');
    // A task's view has two lines of details above its transcript.
    mouse!({ kind: 'press', button: 0, x: 40, y: 6 });
    await tick();
    expect(ui.lastFrame()).toContain('▾ 2 tool calls');
    expect(ui.lastFrame()).toContain('▸ shell ls');
    ui.stdin.write('\u0018'); // ^X t collapses all
    await tick();
    ui.stdin.write('t');
    await tick();
    expect(ui.lastFrame()).not.toContain('▾');
    ui.unmount();
  });

  it('lists tasks in their own section and shows a task in detail', async () => {
    const events = {
      't-a000000002': [
        { seq: 1, ts: 0, event: { type: 'input', text: 'fix the bug', source: 'user' } },
        { seq: 2, ts: 0, event: { type: 'message', text: 'Opened the PR.' } },
      ] as StoredEvent[],
    };
    const { client, calls } = fakeClient(events);
    let mouse: ((e: MouseEvent) => void) | undefined;
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[
          task('t-a000000002', 'dev', {
            title: 'fix the bug',
            links: ['https://github.com/o/r/pull/9'],
          }),
          task('t-a000000001', 'dev', { status: 'running', title: 'older task' }),
        ]}
        onMouse={(h) => (mouse = h)}
      />,
    );
    await tick();
    const frame = ui.lastFrame() ?? '';
    for (const header of ['CONFIGURE', 'AGENTS', 'TASKS']) expect(frame).toContain(header);
    expect(frame).toContain('@dev fix the bug');
    // Rows: title, CONFIGURE, 5 settings, AGENTS, builder, dev, TASKS, then the tasks.
    mouse!({ kind: 'press', button: 0, x: 5, y: 2 + 14 });
    await tick();
    expect(ui.lastFrame()).toContain('t-a000000002 · @dev · done');
    expect(ui.lastFrame()).toContain('https://github.com/o/r/pull/9');
    expect(ui.lastFrame()).toContain('Artifacts and links');
    ui.stdin.write('\u000e'); // ^N → the running task
    await tick();
    ui.stdin.write('\r'); // the click focused the sidebar; Enter opens the task
    await tick();
    expect(ui.lastFrame()).toContain('^X c cancel');
    // Letters go to the reply input; the task's actions take the leader.
    ui.stdin.write('c');
    await tick();
    expect(calls.some(([m]) => m === 'tasks.cancel')).toBe(false);
    ui.stdin.write('\u007f\u0018');
    await tick();
    ui.stdin.write('c');
    await tick();
    ui.stdin.write('y');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.cancel')?.[1]).toEqual({ taskId: 't-a000000001' });
    ui.stdin.write('\u0018'); // ^X n: the agent's view, listing its tasks
    await tick();
    ui.stdin.write('n');
    await tick();
    expect(ui.lastFrame()).toContain('@dev · dev');
    expect(ui.lastFrame()).toContain('t-a000000001  older task');
    ui.unmount();
  });

  it('moves between the sidebar and the main pane with the keyboard alone', async () => {
    const { client, calls } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[
          task('t-a000000002', 'dev', { title: 'newer' }),
          task('t-a000000001', 'dev', { status: 'running', title: 'older' }),
        ]}
      />,
    );
    await tick();
    // Starts in the chat of the first agent; typing goes to the input.
    ui.stdin.write('hi');
    await tick();
    ui.stdin.write('\u001b'); // Esc clears the draft...
    await tick();
    ui.stdin.write('\u001b'); // ...then moves to the sidebar
    await tick();
    expect(ui.lastFrame()).toContain('Tab pane');
    ui.stdin.write('3'); // Tasks section
    await tick();
    expect(ui.lastFrame()).toContain('t-a000000002 · @dev · done');
    ui.stdin.write('j'); // next task
    await tick();
    ui.stdin.write('\r'); // open it
    await tick();
    ui.stdin.write('\u0018'); // ^X c
    await tick();
    ui.stdin.write('c');
    await tick();
    expect(calls.some(([m]) => m === 'tasks.cancel')).toBe(false);
    ui.stdin.write('y');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.cancel')?.[1]).toEqual({ taskId: 't-a000000001' });
    ui.stdin.write('\u001b'); // back to the sidebar
    await tick();
    ui.stdin.write('1'); // Configure → Runtimes
    await tick();
    ui.stdin.write('\u001b[C'); // → opens it
    await tick();
    expect(ui.lastFrame()).toContain('VM: running');
    ui.stdin.write('\t'); // Tab back to the sidebar
    await tick();
    ui.stdin.write('?');
    await tick();
    expect(ui.lastFrame()).toContain('Keys');
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).not.toContain('Esc or ? close');
    ui.unmount();
  });

  it('filters the task list', async () => {
    const { client } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev'), agent('ops')]}
        initialTasks={[
          task('t-a000000003', 'ops', { title: 'rotate logs', status: 'failed' }),
          task('t-a000000002', 'dev', { title: 'fix login' }),
          task('t-a000000001', 'dev', { title: 'fix signup', status: 'failed' }),
        ]}
      />,
    );
    await tick();
    expect(filterTasks([task('t-1', 'dev', { title: 'Fix X' })], '@dev fix')).toHaveLength(1);
    ui.stdin.write('\u001b'); // to the sidebar
    await tick();
    ui.stdin.write('/');
    await tick();
    ui.stdin.write('@dev status:failed');
    await tick();
    ui.stdin.write('\r');
    await tick();
    let frame = ui.lastFrame() ?? '';
    expect(frame).toContain('TASKS · filtered');
    expect(frame).toContain('fix signup');
    expect(frame).not.toContain('@dev fix login');
    expect(frame).not.toContain('rotate logs');
    // An empty filter shows everything again.
    ui.stdin.write('/');
    await tick();
    for (const _ of '@dev status:failed') ui.stdin.write('\u007f');
    await tick();
    ui.stdin.write('\r');
    await tick();
    frame = ui.lastFrame() ?? '';
    expect(frame).toContain('rotate logs');
    ui.unmount();
  });

  it('pages through many tasks', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      task(`t-b${String(i).padStart(9, '0')}`, 'dev', { title: `task number ${i}` }),
    );
    const { client } = fakeClient();
    let mouse: ((e: MouseEvent) => void) | undefined;
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={many}
        onMouse={(h) => (mouse = h)}
      />,
    );
    await tick();
    const frame = ui.lastFrame() ?? '';
    const pages = /TASKS 1\/(\d+)/.exec(frame);
    expect(Number(pages?.[1])).toBeGreaterThan(1);
    expect(frame).toContain('task number 0');
    expect(frame).toContain('next ›');
    // Select the first task, then turn the page with ].
    mouse!({ kind: 'press', button: 0, x: 5, y: 12 });
    await tick();
    ui.stdin.write(']');
    await tick();
    expect(ui.lastFrame()).toContain('TASKS 2/');
    expect(ui.lastFrame()).not.toContain('task number 0 ');
    expect(ui.lastFrame()).toContain('‹ prev');
    ui.unmount();
  });

  it('imports from gh and connects an AWS profile only after confirmation', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    await tick();
    ui.stdin.write('\u0010'); // ^P → access
    ui.stdin.write('\u0010'); // ^P → usage
    ui.stdin.write('\u0010'); // ^P → connectors
    await tick();
    ui.stdin.write('g');
    await tick();
    expect(ui.lastFrame()).toContain('gh auth token');
    ui.stdin.write('n');
    await tick();
    expect(calls.some(([m]) => m === 'connectors.importGh')).toBe(false);
    ui.stdin.write('g');
    await tick();
    ui.stdin.write('y');
    await tick();
    expect(calls.some(([m]) => m === 'connectors.importGh')).toBe(true);
    ui.stdin.write('j'); // aws
    await tick();
    ui.stdin.write('p');
    await tick();
    ui.stdin.write('dev-sso');
    await tick();
    expect(ui.lastFrame()).toContain('dev-sso');
    ui.stdin.write('\r');
    await tick();
    expect(calls.find(([m]) => m === 'connectors.awsProfile')?.[1]).toEqual({ profile: 'dev-sso' });
    ui.unmount();
  });

  it('runs setup steps from the runtimes screen after confirmation', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<App client={client} initialAgents={[]} initialTasks={[]} />);
    await tick();
    for (const _ of [1, 2, 3, 4, 5]) ui.stdin.write('\u0010'); // ^P ×5 → runtimes
    await tick();
    expect(ui.lastFrame()).toContain('start VM');
    ui.stdin.write('u');
    await tick();
    expect(ui.lastFrame()).toContain('vault.key');
    ui.stdin.write('y');
    await tick();
    expect(calls.find(([m]) => m === 'setup.run')?.[1]).toEqual({ action: 'vault-unlock' });
    emit('setup', { action: 'vault-unlock', line: '\u001b]52;c;AAAA\u0007{"unlocked": true}' });
    await tick();
    expect(ui.lastFrame()).toContain('{"unlocked": true}');
    expect(ui.lastFrame()).not.toContain(']52;');
    ui.unmount();
  });

  it('asks for approval of held writes in a full-screen dialog', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    const approval = {
      id: 'a'.repeat(16),
      kind: 'proxy' as const,
      task: 't-a000000001',
      agent: 'dev',
      connector: 'github',
      operation: 'POST /o/r.git/git-receive-pack',
      host: 'github.com',
      summary: `git push: refs/heads/fix${ESC}]52;c;AAAA\u0007`,
      createdAt: Date.now(),
      timeout: 300,
      reason: 'high-risk: push to main or master',
      origin: 'poll → @lead (t-a000000000) → @dev (t-a000000001)',
    };
    ui.stdin.write('my draft');
    emit('approvals', { approvals: [approval] });
    await tick();
    expect(ui.lastFrame()).not.toContain('Approve a write by @dev?');
    expect(ui.lastFrame()).toContain('my draft');
    ui.stdin.write('y');
    await tick();
    expect(calls.some(([m]) => m === 'approvals.decide')).toBe(false);
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('a');
    const frame = await frameWith(ui, 'Approve a write by @dev?');
    expect(frame).toContain('why        high-risk: push to main or master');
    expect(frame).toContain('started by poll → @lead (t-a000000000) → @dev (t-a000000001)');
    expect(frame).toContain('git push: refs/heads/fix');
    expect(frame).not.toContain(']52;');
    ui.stdin.write('\u001b'); // later
    expect(await frameWith(ui, '1 write waiting for approval (^X a)')).toContain(
      '1 write waiting for approval (^X a)',
    );
    ui.stdin.write('\u0018'); // ^X a
    await tick();
    ui.stdin.write('a');
    await frameWith(ui, 'Approve a write by @dev?');
    ui.stdin.write('n');
    await tick();
    expect(calls.some(([m]) => m === 'approvals.decide')).toBe(false);
    ui.stdin.write('\r');
    await tick();
    expect(calls.find(([m]) => m === 'approvals.decide')?.[1]).toEqual({
      id: 'a'.repeat(16),
      allow: false,
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
        kind: 'create',
        agentYaml: 'runtime: codex\n',
        imageYaml: null,
        agentDiff: `+ runtime: codex\n+ prompt: ${ESC}[2Jhidden`,
        imageDiff: '',
        errors: [],
        warnings: [],
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
        kind: 'create',
        agentYaml: '',
        imageYaml: null,
        agentDiff: '',
        imageDiff: '',
        errors: ['bad'],
        warnings: [],
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

describe('CLI renderer', () => {
  const sink = (isTTY: boolean) => {
    let text = '';
    const out = { isTTY, columns: 80, write: (s: string) => ((text += s), true) };
    return { out: out as unknown as NodeJS.WriteStream, text: () => text };
  };
  const events: RuntimeEvent[] = [
    { type: 'tool.call', id: '1', name: 'shell', input: '{"command":"ls"}' },
    { type: 'tool.result', id: '1', output: 'x', isError: false },
    { type: 'tool.call', id: '2', name: 'shell', input: '{"command":"false"}' },
    { type: 'tool.result', id: '2', output: 'boom', isError: true },
    { type: 'message', text: 'done' },
  ];

  it('folds a run of tool calls into one summary line when piped', () => {
    const s = sink(false);
    const r = new TerminalRenderer(s.out);
    for (const e of events) r.render(e);
    const plain = s.text().replace(/\u001b\[[0-9;]*m/g, '');
    expect(plain).toBe('▸ 2 tool calls (1 failed) · last: shell false\ndone\n');
  });

  it('rewrites the line in place on a terminal', () => {
    const s = sink(true);
    const r = new TerminalRenderer(s.out);
    for (const e of events.slice(0, 3)) r.render(e);
    expect(s.text()).toContain('\r\u001b[2K');
    expect(s.text()).not.toContain('\n');
    r.flush();
    expect(s.text().replace(/\u001b\[[0-9;]*m/g, '')).toMatch(
      /2 tool calls · last: shell false\n$/,
    );
  });
});

describe('key bindings in the TUI', () => {
  const LEADER = '\u0018'; // ^X

  it('edits the draft at the cursor with standard line-editing keys', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write('helo world');
    await tick();
    ui.stdin.write('\u0001'); // ^A: start of the line
    await tick();
    for (const _ of [1, 2, 3]) ui.stdin.write(`${ESC}[C`); // →
    await tick();
    ui.stdin.write('l');
    await tick();
    ui.stdin.write('\u0005'); // ^E: end
    await tick();
    ui.stdin.write('\u0017'); // ^W: delete the word before
    await tick();
    ui.stdin.write('there\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({
      agentId: 'dev',
      text: 'hello there',
    });
    ui.unmount();
  });

  it('runs commands from the palette, filtered by what you type', async () => {
    const { client } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write(' ');
    expect(await frameWith(ui, 'Commands · Agent view')).toContain('Compose in $EDITOR');
    ui.stdin.write('new task');
    await tick();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain("New task for this agent (from a task: its agent's view)");
    expect(frame).toContain('^X n');
    expect(frame).not.toContain('Compose in $EDITOR');
    ui.stdin.write('\r');
    expect(await frameWith(ui, 'each message here starts a new task')).toContain(
      'New task for @dev',
    );
    ui.unmount();
  });

  it('keeps the commands and keys hints on the status line however many hints the view has', async () => {
    const { client } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    const last = (await frameWith(ui, 'keys')).trimEnd().split('\n').at(-1) ?? '';
    expect(last).toMatch(/\^X Space commands · \^X \? keys$/);
    ui.unmount();
  });

  it('shows the keys of the focused view, with line editing in the chat', async () => {
    const { client } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write('?');
    const frame = await frameWith(ui, 'Agent chat');
    expect(frame).toContain('Compose in $EDITOR');
    expect(frame).toContain('Everywhere (leader ^X');
    ui.unmount();
  });

  it('handles a chord that arrives in one read', async () => {
    const { client, calls } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    ui.stdin.write(`${LEADER}nfre\u0001x\u0005sh\r`); // ^A x ^E within the same read
    await tick();
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({
      agentId: 'dev',
      text: 'xfresh',
    });
    ui.unmount();
  });

  it('cancels a chord with Esc and names a chord that is not bound', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write(LEADER);
    expect(await frameWith(ui, '^X …')).toContain('Next key');
    ui.stdin.write(ESC);
    await tick();
    expect(ui.lastFrame()).not.toContain('Next key');
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write('z');
    expect(await frameWith(ui, 'is not bound')).toContain('^X z is not bound here');
    // Neither key reached the input.
    ui.stdin.write('ok\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({ agentId: 'dev', text: 'ok' });
    ui.unmount();
  });

  it('follows a configured leader and bindings', async () => {
    const { client, calls } = fakeClient();
    const { keymap } = buildKeyMap({
      leader: 'ctrl+g',
      bindings: [{ context: 'chat', bindings: { 'alt+n': 'task:new' } }],
    });
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
        keymap={keymap}
        keyWarnings={['one']}
      />,
    );
    expect(await frameWith(ui, 'keybindings.json: 1 problem')).toContain('run `anchi keys`');
    ui.stdin.write(`${ESC}n`); // Alt+N
    await tick();
    ui.stdin.write('fresh\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({
      agentId: 'dev',
      text: 'fresh',
    });
    ui.stdin.write('\u0007'); // ^G: the leader now, no longer the editor key
    expect(await frameWith(ui, 'Next key')).toContain('^G …');
    ui.unmount();
  });
});

describe('agent settings panel', () => {
  const LEADER = '\u0018';
  const settings = (over: Partial<AgentSettings['current']> = {}): AgentSettings => ({
    agentId: 'dev',
    editable: true,
    current: {
      name: 'dev',
      description: '',
      runtime: 'codex',
      model: '',
      effort: '',
      prompt: { mode: 'append', text: '' },
      skills: [],
      connectors: ['github'],
      workspaces: [],
      ...over,
    },
    inherited: [],
    fixed: {
      image: 'codex',
      sandbox: 'cell',
      delegates: [],
      triggers: [],
      approvals: {},
      egress: null,
    },
    inventory: {
      skills: [{ id: 'review', name: 'review', description: 'Reviews pull requests' }],
      connectors: [
        { id: 'github', connected: true },
        { id: 'notion', connected: false },
      ],
      workspaces: { shared: true, dirs: ['projects/webapp'] },
      runtimes: [],
      agents: ['dev'],
      images: [],
    },
  });
  const update = {
    diff: '  runtime: codex\n+ skills: [review]',
    errors: [],
    warnings: [],
    base: 'b1',
    applied: false,
  };

  it('selects skills, connectors and workspaces, shows the change and saves only after y', async () => {
    const { client, calls } = fakeClient(
      {},
      {
        'agents.settings': () => settings(),
        'agents.update': (p) => ({ ...update, applied: Boolean((p as { apply?: boolean }).apply) }),
      },
    );
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write('s');
    let frame = await frameWith(ui, 'Reviews pull requests');
    expect(frame).toContain('@dev: settings');
    expect(frame).toMatch(/\[x\] +github +connected/);
    expect(frame).toMatch(/\[ \] +notion +not connected/);
    for (const _ of [1, 2, 3, 4, 5, 6, 7]) ui.stdin.write('j'); // past name … prompt
    await tick();
    ui.stdin.write(' '); // the first skill: review
    await tick();
    for (const _ of [1, 2, 3, 4, 5, 6, 7, 8]) ui.stdin.write('j'); // down to the workspace
    await tick();
    ui.stdin.write(' ');
    await tick();
    ui.stdin.write(' '); // ro → rw
    frame = await frameWith(ui, '[rw]');
    expect(frame).toContain('writes go straight to your computer');
    ui.stdin.write('\r');
    frame = await frameWith(ui, 'save these settings?');
    expect(frame).toContain('+ skills: [review]');
    expect(calls.filter(([m]) => m === 'agents.update')).toEqual([
      [
        'agents.update',
        {
          agentId: 'dev',
          patch: { skills: ['review'], workspaces: [{ path: 'projects/webapp', mode: 'rw' }] },
        },
      ],
    ]);
    ui.stdin.write('y');
    expect(await frameWith(ui, 'settings saved')).toContain('@dev settings saved');
    expect(calls.at(-1)).toEqual([
      'agents.update',
      {
        agentId: 'dev',
        patch: { skills: ['review'], workspaces: [{ path: 'projects/webapp', mode: 'rw' }] },
        apply: true,
        base: 'b1',
      },
    ]);
    ui.unmount();
  });

  it('edits runtime, model and the prompt (in $EDITOR), and shows warnings before saving', async () => {
    const { client, calls } = fakeClient(
      {},
      {
        'agents.settings': () => settings(),
        'agents.update': () => ({
          ...update,
          diff: '- runtime: codex\n+ runtime: claude-code\n+ model: claude-sonnet-5-5',
          warnings: ['runtime claude-code is not connected yet'],
        }),
      },
    );
    const compose = vi.fn((draft: string) => `${draft}Line one.\nLine two.\n\n`);
    const ui = render(
      <App client={client} initialAgents={[agent('dev')]} initialTasks={[]} compose={compose} />,
    );
    await tick();
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write('s');
    let frame = await frameWith(ui, '(runtime default)');
    expect(frame).toMatch(/runtime +codex/);
    for (const _ of [1, 2]) ui.stdin.write('j');
    await tick();
    ui.stdin.write(' '); // runtime: codex → claude-code
    frame = await frameWith(ui, 'claude-code');
    expect(frame).toMatch(/\* +runtime +claude-code/);
    ui.stdin.write('j');
    await tick();
    ui.stdin.write(' '); // model: type it
    await tick();
    ui.stdin.write('bad model');
    await tick();
    ui.stdin.write('\r');
    expect(await frameWith(ui, 'a model id has')).toContain('Enter keep');
    for (const _ of 'bad model') ui.stdin.write('\u007f');
    await tick();
    ui.stdin.write('claude-sonnet-5-5');
    await tick();
    ui.stdin.write('\r');
    frame = await frameWith(ui, 'Space change');
    expect(frame).toMatch(/\* +model +claude-sonnet-5-5/);
    for (const _ of [1, 2, 3]) ui.stdin.write('j');
    await tick();
    ui.stdin.write(' '); // the prompt text, in the editor
    frame = await frameWith(ui, '2 lines');
    expect(compose).toHaveBeenCalledWith('');
    expect(frame).toContain('│ Line one.');
    ui.stdin.write('\r');
    frame = await frameWith(ui, 'save these settings?');
    expect(frame).toContain('! runtime claude-code is not connected yet');
    expect(frame).toContain('[y] save');
    expect(calls.find(([m]) => m === 'agents.update')?.[1]).toEqual({
      agentId: 'dev',
      patch: {
        runtime: 'claude-code',
        model: 'claude-sonnet-5-5',
        prompt: { text: 'Line one.\nLine two.\n' },
      },
    });
    ui.stdin.write('y');
    expect(await frameWith(ui, 'settings saved')).toContain('@dev settings saved');
    ui.unmount();
  });

  it('shows the diff of a builder patch to an existing agent and applies it on y', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    emit('proposal', {
      proposal: {
        id: 'p-3',
        agentId: 'dev',
        kind: 'update',
        agentYaml: '# mine\nruntime: codex\nmodel: gpt-5.5\n',
        imageYaml: null,
        agentDiff: '  # mine\n  runtime: codex\n+ model: gpt-5.5',
        imageDiff: '',
        errors: [],
        warnings: [],
        patch: { model: 'gpt-5.5' },
        base: 'b1',
      },
    });
    const frame = await frameWith(ui, 'Changes to @dev');
    expect(frame).toContain('only the + and - lines change');
    expect(frame).toContain('+ model: gpt-5.5');
    expect(frame).toContain('  # mine');
    ui.stdin.write('y');
    await tick();
    expect(calls.find(([m]) => m === 'builder.apply')?.[1]).toEqual({ proposalId: 'p-3' });
    ui.unmount();
  });

  it('cannot save a change with errors, and n goes back to the panel', async () => {
    const { client, calls } = fakeClient(
      {},
      {
        'agents.settings': () => settings({ skills: ['gone'] }),
        'agents.update': () => ({ ...update, errors: ['skill "gone" is not installed'] }),
      },
    );
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write('s');
    expect(await frameWith(ui, 'not installed')).toMatch(/\[x\] +gone +not installed/);
    for (const _ of [1, 2, 3, 4, 5, 6, 7, 8]) ui.stdin.write('j');
    await tick();
    ui.stdin.write(' '); // select review as well
    await tick();
    ui.stdin.write('\r');
    const frame = await frameWith(ui, 'save these settings?');
    expect(frame).toContain('✗ skill "gone" is not installed');
    expect(frame).not.toContain('[y] save');
    ui.stdin.write('y');
    await tick();
    expect(calls.some(([m, p]) => m === 'agents.update' && (p as { apply?: boolean }).apply)).toBe(
      false,
    );
    ui.stdin.write('n');
    expect(await frameWith(ui, '@dev: settings')).toContain('Space change');
    ui.unmount();
  });

  it('revises a builder proposal from its dialog', async () => {
    const proposal = {
      id: 'p-1',
      agentId: 'rev',
      kind: 'create' as const,
      agentYaml: 'runtime: codex\n',
      imageYaml: null,
      agentDiff: '+ runtime: codex',
      imageDiff: '',
      errors: [],
      warnings: [],
    };
    const { client, calls, emit } = fakeClient(
      {},
      {
        'agents.settings': () => ({ ...settings({ connectors: [] }), agentId: 'rev' }),
        'builder.revise': () => ({
          ...proposal,
          agentYaml: 'runtime: codex\nskills: [review]\n',
          agentDiff: '+ runtime: codex\n+ skills: [review]',
          warnings: ['notion is not connected yet'],
        }),
      },
    );
    const ui = render(<App client={client} initialAgents={[agent('builder')]} initialTasks={[]} />);
    await tick();
    emit('proposal', { proposal });
    expect(await frameWith(ui, '[s] settings')).toContain('Builder proposal');
    ui.stdin.write('s');
    expect(await frameWith(ui, 'Proposal for @rev: settings')).toContain('review');
    for (const _ of [1, 2, 3, 4, 5, 6, 7]) ui.stdin.write('j');
    await tick();
    ui.stdin.write(' ');
    await tick();
    ui.stdin.write('\r');
    const frame = await frameWith(ui, '+ skills: [review]');
    expect(frame).toContain('! notion is not connected yet');
    expect(calls.find(([m]) => m === 'agents.settings')?.[1]).toEqual({ proposalId: 'p-1' });
    expect(calls.find(([m]) => m === 'builder.revise')?.[1]).toEqual({
      proposalId: 'p-1',
      patch: { skills: ['review'] },
    });
    ui.unmount();
  });

  it('updates a GitHub skill after showing what changes', async () => {
    const skill = {
      id: 'review',
      name: 'review',
      description: 'Reviews',
      source: 'https://github.com/acme/s/tree/main/review',
      commit: '1'.repeat(40),
    };
    const { client, calls } = fakeClient(
      {},
      {
        'skills.list': () => [skill],
        'skills.checkUpdate': () => ({
          id: 'review',
          url: skill.source,
          current: '1'.repeat(40),
          latest: '2'.repeat(40),
          upToDate: false,
          added: ['checklist.md'],
          changed: ['SKILL.md'],
          removed: [],
        }),
        'skills.update': () => skill,
      },
    );
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write(LEADER);
    await tick();
    ui.stdin.write('1'); // Configure
    await tick();
    ui.stdin.write('\u000e'); // ^N: Runtimes → Skills
    await frameWith(ui, 'acme/s');
    ui.stdin.write('u');
    const frame = await frameWith(ui, 'Update skill review');
    expect(frame).toContain('1111111111 → 2222222222');
    expect(frame).toContain('added: checklist.md');
    expect(frame).toContain('changed: SKILL.md');
    ui.stdin.write('y');
    await frameWith(ui, 'done');
    expect(calls.find(([m]) => m === 'skills.update')?.[1]).toEqual({
      id: 'review',
      commit: '2'.repeat(40),
    });
    ui.unmount();
  });
});

describe('deleting agents', () => {
  const preview = {
    agentId: 'dev',
    exists: true,
    tasks: 3,
    delegated: 1,
    running: 1,
    delegatedBy: ['lead'],
    triggers: 0,
    workspaces: ['projects/web'],
  };
  const answers = {
    'agents.deletePreview': () => preview,
    'agents.delete': () => ({
      agentId: 'dev',
      deletedTasks: 4,
      editedAgents: ['lead'],
      vm: { home: true, skills: true, policy: [] },
      warnings: [],
    }),
  };

  it('lists what goes and what stays, and deletes only after the id is typed', async () => {
    const { client, calls } = fakeClient({}, answers);
    const ui = render(
      <App client={client} initialAgents={[agent('dev'), agent('lead')]} initialTasks={[]} />,
    );
    await tick();
    ui.stdin.write(ESC); // to the sidebar, on @dev
    await tick();
    ui.stdin.write('D');
    const frame = await frameWith(ui, 'Delete @dev?');
    expect(frame).toContain('3 tasks and their transcripts, with 1 task other agents did for them');
    expect(frame).toContain('1 running or queued: cancelled first');
    expect(frame).toContain('Changed: removed from the delegates of @lead');
    expect(frame).toContain('Kept: ~/AnchiWorkspaces/projects/web (workspaces are never touched)');
    ui.stdin.write('\r'); // nothing typed yet
    await tick();
    ui.stdin.write('de');
    await tick();
    ui.stdin.write('\r'); // not the id
    await tick();
    expect(calls.some(([m]) => m === 'agents.delete')).toBe(false);
    ui.stdin.write('v');
    expect(await frameWith(ui, 'Enter delete')).toContain('Type dev to confirm:');
    ui.stdin.write('\r');
    expect(await frameWith(ui, '@dev deleted')).toContain(
      '@dev deleted with 4 tasks; removed from the delegates of @lead',
    );
    expect(calls.find(([m]) => m === 'agents.delete')?.[1]).toEqual({
      agentId: 'dev',
      confirm: 'dev',
    });
    ui.unmount();
  });

  it('D on a task in the sidebar deletes the task, not its agent; D in the settings panel deletes the agent', async () => {
    const { client, calls } = fakeClient(
      {},
      {
        ...answers,
        'agents.settings': () => ({
          agentId: 'dev',
          editable: true,
          current: {
            name: 'dev',
            description: '',
            runtime: 'codex',
            model: '',
            effort: '',
            prompt: { mode: 'append', text: '' },
            skills: [],
            connectors: [],
            workspaces: [],
          },
          inherited: [],
          fixed: {
            image: 'codex',
            sandbox: 'cell',
            delegates: [],
            triggers: [],
            approvals: {},
            egress: null,
          },
          inventory: {
            skills: [],
            connectors: [],
            workspaces: { shared: true, dirs: [] },
            runtimes: [],
            agents: [],
            images: [],
          },
        }),
      },
    );
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    ui.stdin.write(ESC);
    await tick();
    ui.stdin.write('3'); // Tasks: the task is selected
    await tick();
    ui.stdin.write('D');
    expect(await frameWith(ui, 'Delete t-a000000001')).toContain('Delete t-a000000001');
    expect(calls.some(([m]) => m === 'agents.deletePreview')).toBe(false);
    ui.stdin.write('n');
    await tick();
    ui.stdin.write('2'); // Agents
    await tick();
    ui.stdin.write('s');
    expect(await frameWith(ui, 'D delete the agent')).toContain('@dev: settings');
    ui.stdin.write('D');
    expect(await frameWith(ui, 'Delete @dev?')).toContain('Type dev to confirm:');
    ui.unmount();
  });
});

describe('running a failed task again', () => {
  it("offers to continue the session or start over, from the task's view", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        'tasks.retry': (p) => {
          const { taskId, fresh } = p as { taskId: string; fresh: boolean };
          return task(fresh ? 't-new0000001' : taskId, 'dev', { status: 'queued' });
        },
      },
    );
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev', { status: 'failed' })]}
      />,
    );
    await tick();
    ui.stdin.write('\u001b'); // to the sidebar
    await tick();
    ui.stdin.write('3'); // the task
    await tick();
    ui.stdin.write('\t'); // its view
    expect(await frameWith(ui, '^X r retry')).toContain('^X r retry');
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('r');
    expect(await frameWith(ui, 'Run t-a000000001 (@dev) again?')).toContain('It failed.');
    ui.stdin.write('c');
    expect(await frameWith(ui, 't-a000000001 continues')).toContain('@dev');
    expect(calls.find(([m]) => m === 'tasks.retry')?.[1]).toEqual({
      taskId: 't-a000000001',
      fresh: false,
    });
    ui.stdin.write('\u0018'); // ^X r again, in the task's view it opened
    await tick();
    ui.stdin.write('r');
    await frameWith(ui, 'again?');
    ui.stdin.write('n');
    expect(await frameWith(ui, 'started again as')).toContain(
      't-a000000001 started again as t-new0000001',
    );
    expect(calls.filter(([m]) => m === 'tasks.retry').at(-1)?.[1]).toEqual({
      taskId: 't-a000000001',
      fresh: true,
    });
    ui.unmount();
  });
});

describe('access and usage views', () => {
  it('allows a refused host from the access view after a confirmation', async () => {
    const refused = (host: string) => ({
      ts: 1000,
      method: '',
      host,
      path: '',
      operation: '',
      decision: 'egress-denied',
      rule: '',
      credential: '',
      reason: '',
    });
    const audit = {
      taskId: 't-a000000001',
      total: 2,
      truncated: false,
      cells: 1,
      registration: null,
      requests: 0,
      injected: {},
      credentialsSent: {},
      hosts: [],
      refused: [refused('pypi.org'), refused('evil.example'), refused('pypi.org')],
      held: [],
      streamed: 0,
      bridge: [],
      scan: null,
      rows: [],
    };
    const { client, calls } = fakeClient(
      {},
      { 'tasks.audit': () => audit, 'agents.allowHost': () => ({ egress: ['evil.example'] }) },
    );
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    ui.stdin.write(ESC);
    await tick();
    ui.stdin.write('3');
    await tick();
    ui.stdin.write('\t');
    await tick();
    ui.stdin.write('\u0018'); // ^X l: the task's access
    await tick();
    ui.stdin.write('l');
    expect(await frameWith(ui, 'e allow a refused host')).toContain('egress-denied');
    ui.stdin.write('e');
    expect(await frameWith(ui, 'Allow a host this task was refused')).toContain('› pypi.org');
    ui.stdin.write('j');
    expect(await frameWith(ui, '› evil.example')).toContain('  pypi.org');
    ui.stdin.write('\r');
    expect(await frameWith(ui, 'Allow evil.example for @dev')).toContain(
      'send it whatever they read',
    );
    ui.stdin.write('y');
    await tick();
    await tick();
    expect(calls.filter(([m]) => m === 'agents.allowHost')).toEqual([
      ['agents.allowHost', { agentId: 'dev', host: 'evil.example' }],
    ]);
    ui.unmount();
  });

  it("opens a task's external access with ^X l, and the usage screen with its periods and groupings", async () => {
    const audit = {
      taskId: 't-a000000001',
      total: 1,
      truncated: false,
      cells: 1,
      registration: {
        connectors: ['github'],
        services: [],
        egress: ['github.com'],
        ask: ['github'],
      },
      requests: 1,
      injected: { 'github-api': 1 },
      credentialsSent: { placeholder: 1 },
      hosts: [{ host: 'api.github.com', requests: 1, injected: 1, decisions: { inject: 1 } }],
      refused: [],
      held: [],
      streamed: 0,
      bridge: [],
      scan: 'credential scan before closing the cell: clean (3 files)',
      rows: [],
    };
    const { client, calls } = fakeClient(
      {},
      {
        'tasks.audit': () => audit,
        'usage.summary': () => [],
        'usage.quota': () => [],
        'access.summary': () => ({
          since: 0,
          tasks: 1,
          agents: [
            {
              agent: 'dev',
              tasks: 1,
              requests: 4,
              injected: { 'github-api': 2 },
              credentialsOther: 0,
              refused: 1,
              held: 0,
              hosts: 2,
              services: 0,
            },
          ],
          hosts: [],
          services: [],
          credentials: [],
          refused: [],
          partial: false,
        }),
      },
    );
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev')]}
      />,
    );
    await tick();
    ui.stdin.write(ESC);
    await tick();
    ui.stdin.write('3');
    await tick();
    ui.stdin.write('\t');
    expect(await frameWith(ui, '^X l access')).toContain('^X l access');
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('l');
    const frame = await frameWith(ui, '1 with credentials injected by the proxy');
    expect(frame).toContain('1 with credentials injected by the proxy');
    expect(frame).toContain('egress       github.com');
    ui.stdin.write(ESC);
    await tick();
    ui.stdin.write('\t'); // the sidebar
    await tick();
    ui.stdin.write('1'); // Configure: runtimes
    await tick();
    for (const _ of [1, 2, 3]) ui.stdin.write('j'); // → usage
    await tick();
    ui.stdin.write('\r');
    expect(await frameWith(ui, 'Not seen yet')).toContain('Tokens, last 7 days, by agent');
    ui.stdin.write('p');
    expect(await frameWith(ui, 'last 30 days')).toContain('Tokens, last 30 days, by agent');
    ui.stdin.write('b');
    expect(await frameWith(ui, 'by model')).toContain('Tokens, last 30 days, by model');
    const asked = calls
      .filter(([m]) => m === 'usage.summary')
      .map(([, p]) => (p as { by: string }).by);
    expect(asked).toEqual(['agent', 'agent', 'model']);
    ui.stdin.write('\t'); // the sidebar
    await tick();
    ui.stdin.write('j'); // → access
    await tick();
    ui.stdin.write('\r');
    expect(await frameWith(ui, 'By agent')).toContain('the cells sent only placeholders');
    ui.stdin.write('p');
    expect(await frameWith(ui, 'github-api 2')).toContain('External access, last 30 days');
    expect(calls.filter(([m]) => m === 'access.summary')).toHaveLength(2);
    ui.unmount();
  });
});

describe('usability workflows', () => {
  it('keeps a failed send draft and exposes a persistent recovery screen', async () => {
    const { client, calls } = fakeClient(
      {},
      {
        'tasks.create': () => {
          throw new Error('vault is locked');
        },
      },
    );
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write('keep my work');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(calls.filter(([m]) => m === 'tasks.create')).toHaveLength(1);
    expect(ui.lastFrame()).toContain('keep my work');
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('!');
    expect(await frameWith(ui, 'Unlock your credentials')).toContain('vault is locked');
    ui.stdin.write('\r');
    expect(await frameWith(ui, 'Welcome to Anchi')).toContain('Welcome to Anchi');
    ui.unmount();
  });

  it('keeps drafts per agent and Escape never cancels a running task', async () => {
    const { client, calls } = fakeClient();
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev'), agent('ops')]}
        initialTasks={[task('t-running', 'dev', { status: 'running' })]}
      />,
    );
    await tick();
    ui.stdin.write('dev draft');
    await tick();
    ui.stdin.write('\u001b');
    await tick();
    expect(calls.some(([m]) => m === 'tasks.cancel')).toBe(false);
    ui.stdin.write('\u000e');
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('ops draft');
    await tick();
    expect(ui.lastFrame()).toContain('ops draft');
    expect(ui.lastFrame()).not.toContain('dev draft');
    ui.stdin.write('\u0010');
    await tick();
    expect(ui.lastFrame()).toContain('dev draft');
    expect(ui.lastFrame()).not.toContain('ops draft');
    ui.unmount();
  });

  it('turns mouse reporting off in selection mode and back on with any other key', async () => {
    const { client } = fakeClient({
      't-a000000001': [{ seq: 1, ts: 0, event: { type: 'message', text: 'copy me' } }],
    });
    const mouse: boolean[] = [];
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[task('t-a000000001', 'dev', { status: 'running' })]}
        setMouse={(on) => mouse.push(on)}
      />,
    );
    await tick();
    await openTask(ui);
    await frameWith(ui, 'copy me');
    ui.stdin.write('\u0018'); // ^X
    await tick();
    ui.stdin.write('m');
    const frame = await frameWith(ui, 'drag to select');
    expect(mouse).toEqual([false]);
    // No border or sidebar around the transcript.
    expect(frame).not.toContain('AGENTS');
    expect(
      frame
        .split('\n')
        .find((l) => l.includes('copy me'))
        ?.trimEnd(),
    ).toBe('copy me');
    ui.stdin.write('\u001b[A'); // ↑ scrolls and stays in selection mode
    await tick();
    expect(mouse).toEqual([false]);
    ui.stdin.write('x');
    await tick();
    expect(mouse).toEqual([false, true]);
    expect(ui.lastFrame()).not.toContain('drag to select');
    ui.unmount();
  });

  it('shows what a running turn is doing under its transcript', async () => {
    const { client } = fakeClient({
      't-a000000001': [
        { seq: 1, ts: 0, event: { type: 'input', text: 'design an agent', source: 'user' } },
        { seq: 2, ts: 0, event: { type: 'progress', text: '**Picking connectors**' } },
      ],
    });
    const ui = render(
      <App
        client={client}
        initialAgents={[agent('dev')]}
        initialTasks={[
          task('t-a000000001', 'dev', { status: 'running', startedAt: Date.now() - 65_000 }),
        ]}
      />,
    );
    // The agent's view lists the running task with what it is doing…
    const list = await frameWith(ui, 'Picking connectors');
    expect(list).toMatch(/● running\s+t-a000000001  fix it[ │]*\n[^\n]*│ {5}Picking connectors/);
    expect(ui.lastFrame()).toContain('New task for @dev · 1 running');
    // …and the task's view shows it under the transcript.
    await openTask(ui);
    const frame = await frameWith(ui, 'working 1m');
    expect(frame).toMatch(/working 1m\d+s · Picking connectors/);
    ui.unmount();
  });

  it('previews multiline input without sending until explicitly confirmed', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<App client={client} initialAgents={[agent('dev')]} initialTasks={[]} />);
    await tick();
    ui.stdin.write('第一行\nsecond line');
    await tick();
    expect(calls.some(([m]) => m === 'tasks.create')).toBe(false);
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('second line');
    expect(calls.some(([m]) => m === 'tasks.create')).toBe(false);
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).toContain('第一行');
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(calls.find(([m]) => m === 'tasks.create')?.[1]).toEqual({
      agentId: 'dev',
      text: '第一行\nsecond line',
    });
    ui.unmount();
  });

  it('resumes onboarding at the missing vault step', async () => {
    const { client, calls } = fakeClient(
      {},
      {
        'setup.status': () => ({
          vm: 'running',
          installed: true,
          vaultUnlocked: false,
          vaultKeyPresent: false,
          codex: { connected: false, expiresAt: null },
        }),
      },
    );
    const ui = render(
      <App
        client={client}
        initialView="welcome"
        initialAgents={[agent('builder')]}
        initialTasks={[]}
      />,
    );
    expect(await frameWith(ui, 'Initialize the vault')).toContain('✓ Prepare local environment');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Initialize the vault');
    expect(calls.some(([m]) => m === 'setup.run')).toBe(false);
    ui.stdin.write('y');
    await tick();
    expect(calls.find(([m]) => m === 'setup.run')?.[1]).toEqual({ action: 'vault-init' });
    ui.unmount();
  });

  it('shows results first and can reveal the event history', async () => {
    const { client } = fakeClient({
      't-result': [{ seq: 1, ts: 1, event: { type: 'message', text: 'intermediate event' } }],
    });
    const ui = render(
      <App
        client={client}
        initialView="task:t-result"
        initialAgents={[agent('dev')]}
        initialTasks={[
          task('t-result', 'dev', {
            result: 'final answer',
            links: ['https://example.com/artifact'],
          }),
        ]}
      />,
    );
    await tick();
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('3');
    await tick();
    expect(ui.lastFrame()).toContain('final answer');
    expect(ui.lastFrame()).toContain('https://example.com/artifact');
    expect(ui.lastFrame()).not.toContain('intermediate event');
    ui.stdin.write('\u0018');
    await tick();
    ui.stdin.write('h');
    await tick();
    expect(ui.lastFrame()).toContain('intermediate event');
    ui.unmount();
  });
});

describe('onboarding and team state', () => {
  it('resumes each setup stage and detects expired runtime credentials', async () => {
    const { client } = fakeClient();
    const ready = await client.call('setup.status');
    expect(nextSetupAction({ ...ready, vm: 'stopped' })).toBe('vm-start');
    expect(nextSetupAction({ ...ready, installed: false })).toBe('install');
    expect(nextSetupAction({ ...ready, vaultUnlocked: false, vaultKeyPresent: false })).toBe(
      'vault-init',
    );
    expect(nextSetupAction({ ...ready, vaultUnlocked: false, vaultKeyPresent: true })).toBe(
      'vault-unlock',
    );
    expect(
      nextSetupAction({
        ...ready,
        host: { platform: 'linux', missing: ['limactl'], installHint: 'Install Lima' },
      }),
    ).toBeUndefined();
    expect(welcomeStep({ ...ready, codex: { ...ready.codex, expiresAt: 1 } }, [], [])).toBe(
      'runtime',
    );
    expect(welcomeStep(ready, [], [])).toBe('agent');
    expect(welcomeStep(ready, [agent('dev')], [])).toBe('task');
    expect(welcomeStep(ready, [agent('dev')], [task('t-done', 'dev')])).toBe('done');
  });
  it('shows actual pending tools and delegated work in the team overview', () => {
    const running = task('t-running', 'dev', { status: 'running' });
    const tool: StoredEvent = {
      seq: 1,
      ts: 1,
      event: { type: 'tool.call', id: 'call-1', name: 'shell', input: '{"command":"git status"}' },
    };
    expect(teamActivity(agent('dev'), [running], [], [tool])).toContain('git status');
    expect(
      teamActivity(
        agent('dev'),
        [running],
        [],
        [
          tool,
          {
            seq: 2,
            ts: 2,
            event: { type: 'tool.result', id: 'call-1', output: 'ok', isError: false },
          },
        ],
      ),
    ).toContain('Working:');
    expect(
      teamActivity(
        agent('dev'),
        [running, task('t-child', 'ops', { status: 'running', parentId: running.id })],
        [],
      ),
    ).toContain('Delegated work in progress: @ops');
  });
});
