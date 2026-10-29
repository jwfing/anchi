// Screenshots the real desktop app against a stand-in daemon that answers with synthetic agents,
// tasks and a transcript; it never contacts a daemon, VM or account. From the repository root:
//   node --import ./anchi/node_modules/tsx/dist/loader.mjs anchi/packages/desktop/scripts/demo.ts
// writes docs/assets/desktop.png and landing/dist/desktop.png.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AgentSummary,
  MethodName,
  Result,
  RuntimeEvent,
  SetupStatus,
  SkillInfo,
  StoredEvent,
  TaskRow,
} from '@anchi/protocol';
import { Peer } from '@anchi/daemon/client';

const repo = resolve(import.meta.dirname, '../../../..');
const now = Date.now();
const minutes = (n: number) => now - n * 60_000;

const agent = (
  id: string,
  runtime: string,
  description: string,
  connectors: string[],
  skills: string[] = [],
): AgentSummary => ({
  id,
  name: id,
  description,
  runtime,
  connectors,
  skills,
  sandbox: 'cell',
  status: 'idle',
  running: 0,
  queued: 0,
  maxTasks: 2,
  file: `/example/agents/${id}.yaml`,
});
const agents: AgentSummary[] = [
  agent('developer', 'codex', 'Fixes bugs and opens pull requests', ['github'], ['testing']),
  agent('reviewer', 'claude-code', 'Reviews pull requests against the team checklist', ['github']),
  agent('ops', 'hermes', 'Answers questions about the test account bill', ['aws']),
];

const task = (
  id: string,
  agentId: string,
  title: string,
  result: string,
  ago: number,
  extra: Partial<TaskRow> = {},
): TaskRow => ({
  id,
  agentId,
  trigger: 'user',
  title,
  status: 'done',
  resumeId: `session-${id}`,
  runtime: agents.find((a) => a.id === agentId)!.runtime!,
  createdAt: minutes(ago),
  startedAt: minutes(ago),
  finishedAt: minutes(ago - 3),
  result,
  links: [],
  parentId: null,
  rootId: id,
  depth: 0,
  turns: 1,
  inputTokens: 48_200,
  outputTokens: 2_900,
  ...extra,
});
const tasks: TaskRow[] = [
  task(
    't-demo1',
    'developer',
    'Explain what the session cookie check in auth/middleware.ts does',
    'It reads the `sid` cookie, looks the session up and rejects expired ones. Expiry is compared in seconds against a timestamp in milliseconds, so sessions never expire.',
    52,
  ),
  task(
    't-demo2',
    'developer',
    'Fix the login validation test and open a pull request',
    'Fixed the email check in `validateLogin` and the test that asserted the old message. All 214 auth tests pass. Opened https://github.com/example/shop/pull/42.',
    18,
    { links: ['https://github.com/example/shop/pull/42'], turns: 2 },
  ),
  task(
    't-demo3',
    'reviewer',
    'Review https://github.com/example/shop/pull/42',
    'Approved with one suggestion: cover the trimmed-whitespace case.',
    9,
    { trigger: 'delegation', parentId: 't-demo2', rootId: 't-demo2', depth: 1 },
  ),
  task('t-demo4', 'ops', 'Why did the test account bill rise in May?', 'Summarized.', 120),
];

const transcript: RuntimeEvent[] = [
  { type: 'input', text: 'Fix the login validation test and open a pull request', source: 'user' },
  { type: 'session.started', resumeId: 'session-t-demo2' },
  { type: 'progress', text: 'Running the auth tests to see the failure.' },
  { type: 'tool.call', id: 'c1', name: 'shell', input: 'pnpm test auth/login' },
  {
    type: 'tool.result',
    id: 'c1',
    output:
      'FAIL auth/login.test.ts\n  ✕ rejects an email without a domain\n    Expected: "Enter a valid email address"\n    Received: undefined',
    isError: true,
  },
  {
    type: 'progress',
    text: 'validateLogin accepts "ana@" because the regex allows an empty domain.',
  },
  {
    type: 'tool.call',
    id: 'c2',
    name: 'apply_patch',
    input: '*** Update File: src/auth/validate.ts',
  },
  { type: 'tool.result', id: 'c2', output: 'Done.', isError: false },
  { type: 'tool.call', id: 'c3', name: 'shell', input: 'pnpm test auth' },
  { type: 'tool.result', id: 'c3', output: 'Tests  214 passed (214)', isError: false },
  { type: 'tool.call', id: 'c4', name: 'shell', input: 'gh pr create --fill' },
  {
    type: 'tool.result',
    id: 'c4',
    output: 'https://github.com/example/shop/pull/42',
    isError: false,
  },
  { type: 'message', text: tasks[1]!.result! },
  { type: 'usage', model: 'gpt-5.5', inputTokens: 48_200, outputTokens: 2_900 },
  { type: 'notice', text: 'credential scan before closing the cell: clean (12 files)' },
  { type: 'turn.completed' },
];
const events = (taskId: string): StoredEvent[] =>
  (taskId === 't-demo2'
    ? transcript
    : [
        { type: 'input', text: tasks.find((t) => t.id === taskId)?.title ?? '', source: 'user' },
        { type: 'message', text: tasks.find((t) => t.id === taskId)?.result ?? '' },
        { type: 'turn.completed' },
      ]
  ).map((event, i) => ({ seq: i + 1, ts: minutes(18 - i * 0.1), event }) as StoredEvent);

const status: SetupStatus = {
  vm: 'running',
  installed: true,
  vaultUnlocked: true,
  vaultKeyPresent: true,
  preparedRuntimes: ['codex', 'claude-code', 'hermes'],
  codex: { runtime: 'codex', connected: true, accountId: 'example', expiresAt: null },
  claude: { runtime: 'claude-code', connected: true, kind: 'oauth', expiresAt: null },
  hermes: {
    runtime: 'hermes',
    connected: true,
    baseUrl: 'https://llm.example.com/v1',
    model: 'example-model',
  },
  connectors: [
    { id: 'github', connected: true, account: 'example' },
    { id: 'aws', connected: true, account: '123456789012', profile: 'example' },
  ],
  services: [],
  googleClient: false,
  workspaces: false,
};
const skills: SkillInfo[] = [];

const answers: { [M in MethodName]?: (params: never) => Result<M> } = {
  'agents.list': () => agents,
  'tasks.list': (p: { agentId?: string }) =>
    tasks.filter((t) => !p.agentId || t.agentId === p.agentId),
  'tasks.events': (p: { taskId: string; afterSeq?: number }) =>
    events(p.taskId).filter((e) => e.seq > (p.afterSeq ?? 0)),
  'setup.status': () => status,
  'approvals.list': () => [],
  'skills.list': () => skills,
  'usage.summary': () => [],
  'usage.quota': () => [],
  'team.nodes': () => [],
};

const home = mkdtempSync(join(tmpdir(), 'anchi-demo-'));
mkdirSync(join(home, 'run'), { recursive: true });
const server = createServer((socket) => {
  new Peer(socket, async (method, params) => {
    const answer = answers[method as MethodName];
    if (!answer) throw new Error(`${method} is not part of the demo`);
    return (answer as (p: unknown) => unknown)(params);
  });
});
await new Promise<void>((ready) => server.listen(join(home, 'run', 'daemon.sock'), ready));

const shot = join(home, 'desktop.png');
const steps = join(home, 'steps.json');
writeFileSync(
  steps,
  JSON.stringify([
    { size: [1440, 900, 2] },
    { waitFor: '.agents' },
    { wait: 1500 },
    { clickText: '@developer' },
    { waitFor: '.task-card-head' },
    { wait: 800 },
    { eval: "[...document.querySelectorAll('.task-card-head')].at(-1).click()" },
    { waitFor: '.panel .t-message' },
    { wait: 800 },
    { shot },
  ]),
);
// Asynchronous, so this process keeps answering the app while drive.mjs runs it.
const code = await new Promise<number | null>((done) =>
  spawn(process.execPath, [join(import.meta.dirname, 'drive.mjs'), steps], {
    env: { ...process.env, ANCHI_HOME: home, ANCHI_CLI: '/usr/bin/false' },
    stdio: 'inherit',
  }).on('close', done),
);
server.close();
if (code !== 0) throw new Error(`drive.mjs exited with ${code}`);
for (const out of ['docs/assets/desktop.png', 'landing/dist/desktop.png']) {
  copyFileSync(shot, join(repo, out));
  console.log(out);
}
