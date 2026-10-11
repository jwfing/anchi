import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeLayout } from '@anchi/core';
import type { QuotaInfo, TaskRow } from '@anchi/protocol';
import {
  Daemon,
  QuotaAlerts,
  DaemonClient,
  type ExecResult,
  Guest,
  type GuestTransport,
  LimaTransport,
  lineDiff,
  parseBlocks,
  summarizeAudit,
  auditHeadline,
} from '../src/index.ts';
import { AUDIT_SAVED_MAX, extractLinks, Store } from '../src/store.ts';

const RUNNER = join(import.meta.dirname, 'fixtures/fake-runner.mjs');

class FakeTransport implements GuestTransport {
  mode = 'ok';
  /** The fake VM cannot be reached for agent purges. */
  purgeFails = false;
  /** Rows the fake egress audit log holds. */
  auditRows: Record<string, unknown>[] = [];
  /** The fake VM cannot be read for audit rows. */
  auditFails = false;
  starts: string[][] = [];
  execs: { args: string[]; stdin: string }[] = [];
  images = new Set(['codex@base']);

  /** Runner processes, standing in for cells; a purge must find them all exited. */
  children: { agent: string; child: ReturnType<typeof spawn> }[] = [];
  purgedWhileRunning = false;
  /** The most fake cells alive at once; the guest allows four. */
  maxLive = 0;

  /** Lines the fake `anchi-cell approvals watch` prints, then it stays open. */
  approvalLines: string[] = [];

  spawn(args: string[]) {
    if (args[1] === 'approvals') {
      return spawn(
        process.execPath,
        [
          '-e',
          'for (const l of JSON.parse(process.argv[1])) console.log(l); setInterval(() => {}, 1e6);',
          JSON.stringify(this.approvalLines),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    }
    this.starts.push(args);
    const child = spawn(process.execPath, [RUNNER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_MODE: this.mode, FAKE_EXIT_FILE: join(root, 'exit-ms') },
    });
    this.children.push({ agent: args[3] ?? '', child });
    this.maxLive = Math.max(
      this.maxLive,
      this.children.filter((c) => c.child.exitCode === null && !c.child.signalCode).length,
    );
    return child;
  }

  async exec(args: string[], stdin = ''): Promise<ExecResult> {
    this.execs.push({ args, stdin });
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
    if (args[0] === 'anchi-cell' && args[1] === 'reap') return ok({ reaped: ['t-old'] });
    if (args[0] === 'anchi-cell' && args[1] === 'audit') {
      if (this.auditFails) return { code: 1, stdout: '{"error": "VM_STOPPED"}', stderr: '' };
      return ok({
        rows: this.auditRows.filter((r) => r.task === args[2]),
        total: 3,
        truncated: false,
      });
    }
    if (args[0] === 'anchi-cell' && args[1] === 'quota') {
      return ok({
        codex: {
          ts: 1791500000.5,
          status: 200,
          headers: {},
          plan: 'team',
          limited: false,
          windows: [
            { name: 'primary', used_percent: 40, window_minutes: 300, reset_at: 1791500157 },
          ],
        },
        anthropic: { ts: 1791500001, status: 429, headers: { 'retry-after': '120' } },
      });
    }
    if (args[0] === 'anchi-cell' && args[1] === 'purge-agent') {
      this.purgedWhileRunning ||= this.children.some(
        (c) => c.agent === args[2] && c.child.exitCode === null && !c.child.signalCode,
      );
      if (this.purgeFails) return { code: 1, stdout: '{"error": "VM_STOPPED"}', stderr: '' };
      return ok({ agent: args[2], home: true, skills: true, policy: [`notion:${args[2]}`] });
    }
    if (args[0] === 'anchi-image' && args[1] === 'status') {
      return ok({ present: this.images.has(`${args[2]}@${args[3]}`) });
    }
    if (args[0] === 'anchi-image' && args[1] === 'build') {
      this.images.add(`${args[2]}@${args[3]}`);
      return ok({ image: args[2], hash: args[3], ok: true, size: 1e6, seconds: 1, log: '/x' });
    }
    if (args[0] === 'anchi-cell' && args[1] === 'scan') {
      this.scans.push(args[2]!);
      return this.scanResult
        ? ok(this.scanResult)
        : { code: 1, stdout: '{"error":"CELL_NOT_RUNNING"}', stderr: '' };
    }
    if (args[0] === 'anchi-cell' && args[1] === 'skills') {
      this.skillSets.push({ agent: args[3]!, files: Object.keys(JSON.parse(stdin).files) });
      return ok({});
    }
    if (args[0] === 'anchi-cell' && args[1] === 'poll') return ok({ items: this.pollItems });
    if (args[0] === 'anchi-cell' && args[1] === 'approvals')
      return ok({ id: args[3], allowed: args[4] === 'allow' });
    if (args[0] === 'anchi-cell' && args[1] === 'verify') {
      if (this.rejectCredential)
        return { code: 1, stdout: '{"error":"CREDENTIAL_REJECTED"}', stderr: '' };
      return ok({ connector: args[2], account: 'octo' });
    }
    if (args[1]?.endsWith('codex_admin.py')) {
      if (args[2] === 'status') {
        return ok({ configured: this.codex !== null, account_id: 'acct', expires_at: this.codex });
      }
      this.codexImports.push(JSON.parse(stdin));
      this.codex = JSON.parse(
        Buffer.from(JSON.parse(stdin).access_token.split('.')[1], 'base64url').toString(),
      ).exp;
      return ok({ configured: true, expires_at: this.codex });
    }
    if (args[1]?.endsWith('policy_admin.py')) {
      if (args[2] === 'show') {
        return args[3] === 'c'.repeat(32)
          ? ok({
              id: args[3],
              digest: 'd'.repeat(64),
              state: 'PENDING',
              principal: 'notion:writer',
              created: Date.now() / 1000,
              expires: Date.now() / 1000 + 600,
              action: { operation: 'notion.create_page', params: { title: 'Notes' } },
            })
          : { code: 1, stdout: '{"error":"APPROVAL_NOT_FOUND"}', stderr: '' };
      }
      return ok({ approval_id: args[3], state: args[2] === 'approve' ? 'APPROVED' : 'DENIED' });
    }
    if (args[1]?.endsWith('admin.py')) {
      const [action, id] = args.slice(2) as [string, string];
      if (action === 'status') return ok(this.vault);
      if (action === 'import-token' || action === 'import-aws') {
        this.vault[id] = { connected: true, account: null };
        this.imported.push({ id, value: JSON.parse(stdin) });
      }
      if (action === 'disconnect') delete this.vault[id];
      if (action === 'set-account') this.vault[id]!.account = JSON.parse(stdin).account;
      return ok({});
    }
    return { code: 1, stdout: '{"error":"UNEXPECTED"}', stderr: '' };
  }

  rejectCredential = false;
  pollItems: { id: string; title: string; url: string }[] = [];
  skillSets: { agent: string; files: string[] }[] = [];
  scans: string[] = [];
  /** Vault Codex expiry (seconds) or null when not configured. */
  codex: number | null = null;
  codexImports: Record<string, string>[] = [];
  scanResult: { clean: boolean; findings: unknown[]; files: number } | null = {
    clean: true,
    findings: [],
    files: 3,
  };
  vault: Record<string, { connected: boolean; account: string | null }> = {};
  imported: { id: string; value: Record<string, string> }[] = [];
  get connected() {
    return Boolean(this.vault.github?.connected);
  }
}

let root: string;
let transport: FakeTransport;
let daemon: Daemon | undefined;
let roomWaitMs: number | undefined;
let client: DaemonClient | undefined;

function write(rel: string, content: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

// Host commands the daemon runs for connector imports (gh, aws).
let hostCalls: string[][];
let hostAnswers: Record<string, string>;
const hostRun = async (cmd: string, args: string[]) => {
  hostCalls.push([cmd, ...args]);
  const answer = hostAnswers[`${cmd} ${args.slice(0, 2).join(' ')}`];
  if (answer === undefined) throw new Error(`${cmd} failed: not logged in`);
  return answer;
};
const SETUP_STEPS = {
  'vm-start': [[process.execPath, '-e', 'console.log("vm started")']],
  install: [
    [process.execPath, '-e', 'console.log("step one")'],
    [process.execPath, '-e', 'console.error("broken"); process.exit(3)'],
  ],
  'vault-init': [],
  workspaces: [],
  'vault-unlock': [[process.execPath, '-e', 'console.log("{\\"unlocked\\": true}")']],
};

async function start(idleMs = 60_000, turnTimeoutMs?: number, workspaceRoot?: string) {
  const layout = homeLayout(root);
  const d = new Daemon({
    workspaceRoot: workspaceRoot ?? join(root, 'no-workspaces'),
    turnTimeoutMs,
    // Tests drive triggers with their own clock through daemon.triggers.tick().
    triggers: false,
    codexSync: false,
    hostRun,
    setupSteps: SETUP_STEPS,
    // Never the real `limactl delete`.
    resetSteps: [['echo', 'deleted']],
    layout,
    guest: new Guest(transport),
    // No limactl: the tests never depend on a VM of the machine they run on.
    lima: new LimaTransport('secure-vm', join(root, 'no-limactl')),
    log: () => {},
    quiet: true,
    idleMs,
    roomWaitMs,
  });
  await d.start();
  daemon = d;
  const c = await DaemonClient.connect(layout.socketFile);
  client = c;
  return { daemon: d, client: c };
}

beforeEach(() => {
  hostCalls = [];
  hostAnswers = {};
  root = mkdtempSync(join(tmpdir(), 'anchi-daemon-'));
  transport = new FakeTransport();
  write('agents/dev.yaml', 'runtime: codex\nconnectors: [github]\n');
});

afterEach(async () => {
  client?.close();
  await daemon?.stop();
  client = undefined;
  daemon = undefined;
});

describe('daemon tasks', () => {
  it('runs a task in a cell and records result, links and events', async () => {
    const { client, daemon } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'fix the bug' });
    expect(task.id).toMatch(/^t-[0-9a-f]{10}$/);
    const done = await client.call('tasks.wait', { taskId: task.id });
    expect(done.status).toBe('done');
    expect(done.result).toMatch(/fix the bug/);
    expect(done.links).toEqual(['https://github.com/o/r/pull/1']);
    expect(done.resumeId).toBe('thread-1');
    expect(transport.starts[0]).toEqual([
      'anchi-cell',
      'start',
      task.id,
      'dev',
      'codex',
      'base',
      'github',
      'cell',
      'codex',
      '-',
      '-',
      '-',
      '-',
    ]);
    const events = await client.call('tasks.events', { taskId: task.id });
    expect(events.map((e) => e.event.type)).toEqual([
      'input',
      'session.started',
      'tool.call',
      'tool.result',
      'message',
      'turn.completed',
    ]);
  });

  it('resets only when confirmed and nothing runs', async () => {
    const { client } = await start();
    const preview = await client.call('setup.resetPreview');
    expect(preview).toMatchObject({ busy: 0, cells: 0, home: root });
    expect(preview.vaultKey).toMatch(/\.config\/secure-vm\/vault\.key$/);
    await expect(client.call('setup.reset', { confirm: 'yes' })).rejects.toThrow(/type reset/);
    const lines: string[] = [];
    client.on('reset', (n) => lines.push(n.line));
    await client.call('setup.reset', { confirm: 'reset' });
    expect(lines).toEqual(['$ echo deleted', 'deleted']);
  });

  it("pins the agent's Google accounts to its cell", async () => {
    write('agents/mail.yaml', 'runtime: codex\nconnectors: [gmail]\naccounts: { gmail: work }\n');
    const { client } = await start();
    const task = await client.call('tasks.create', { agentId: 'mail', text: 'read' });
    await client.call('tasks.wait', { taskId: task.id });
    expect(transport.starts.at(-1)!.slice(6)).toEqual([
      'gmail',
      'cell',
      'codex',
      '-',
      '-',
      '-',
      'gmail=work',
    ]);
  });

  it('reuses the cell for a follow-up and starts a new one after the idle timeout', async () => {
    const { client, daemon } = await start(150);
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'one' });
    const first = await client.call('tasks.wait', { taskId: task.id });
    await client.call('tasks.send', { taskId: task.id, text: 'two' });
    const second = await client.call('tasks.wait', { taskId: task.id });
    const pid = (r: TaskRow) => /pid (\d+)/.exec(r.result!)![1];
    expect(pid(second)).toBe(pid(first));
    expect(second.result).toMatch(/turn 2/);
    await new Promise((r) => setTimeout(r, 400));
    expect(daemon.hub.cellCount()).toBe(0);
    await client.call('tasks.send', { taskId: task.id, text: 'three' });
    const third = await client.call('tasks.wait', { taskId: task.id });
    expect(pid(third)).not.toBe(pid(first));
    // The new cell resumes the persistent runtime session.
    expect(third.result).toMatch(/resume=thread-1/);
    expect(transport.starts).toHaveLength(2);
  });

  it.each(['bad-frame', 'wrong-turn', 'huge', 'fail-start'])(
    'fails the task and ends the cell when the runner misbehaves (%s)',
    async (mode) => {
      transport.mode = mode;
      const { client, daemon } = await start();
      const task = await client.call('tasks.create', { agentId: 'dev', text: 'x' });
      const done = await client.call('tasks.wait', { taskId: task.id });
      expect(done.status).toBe('failed');
      await new Promise((r) => setTimeout(r, 50));
      expect(daemon.hub.cellCount()).toBe(0);
    },
  );

  it('fails a turn that runs past the turn timeout', async () => {
    transport.mode = 'slow';
    const { client } = await start(60_000, 300);
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'forever' });
    const done = await client.call('tasks.wait', { taskId: task.id });
    expect(done.status).toBe('failed');
    expect(done.result).toMatch(/turn timed out/);
  });

  it('runs a failed task again, continuing its session or starting over', async () => {
    transport.mode = 'bad-frame';
    const { client } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'fix issue 7' });
    const failed = await client.call('tasks.wait', { taskId: task.id });
    expect(failed.status).toBe('failed');
    await expect(
      client.call('tasks.retry', {
        taskId: (await client.call('tasks.create', { agentId: 'dev', text: 'y' })).id,
      }),
    ).rejects.toThrow(/only failed or cancelled tasks/);

    transport.mode = 'ok';
    const resumed = await client.call('tasks.retry', { taskId: task.id });
    expect(resumed.id).toBe(task.id);
    const after = await client.call('tasks.wait', { taskId: task.id });
    expect(after.status).toBe('done');
    expect(after.result).toMatch(
      /Your previous turn ended before it finished \(.+\)\. Continue where you stopped/,
    );

    transport.mode = 'bad-frame';
    const again = await client.call('tasks.create', { agentId: 'dev', text: 'fix issue 8' });
    await client.call('tasks.wait', { taskId: again.id });
    transport.mode = 'ok';
    const fresh = await client.call('tasks.retry', { taskId: again.id, fresh: true });
    expect(fresh.id).not.toBe(again.id);
    expect(fresh.title).toBe('fix issue 8');
    expect((await client.call('tasks.wait', { taskId: fresh.id })).result).toMatch(/fix issue 8/);
    const notes = (await client.call('tasks.events', { taskId: again.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notes).toContain(`↻ started again as ${fresh.id}`);
  });

  it("runs up to the agent's maxTasks turns at once and queues the rest", async () => {
    write('agents/dev.yaml', 'runtime: codex\nconnectors: [github]\nmaxTasks: 2\n');
    transport.mode = 'slow';
    const { client } = await start();
    const tasks: { id: string }[] = [];
    for (const text of ['one', 'two', 'three'])
      tasks.push(await client.call('tasks.create', { agentId: 'dev', text }));
    await new Promise((r) => setTimeout(r, 300));
    const status = async () =>
      Promise.all(
        tasks.map(async (t) => (await client.call('tasks.get', { taskId: t.id })).status),
      );
    expect(await status()).toEqual(['running', 'running', 'queued']);
    const summary = (await client.call('agents.list')).find((x) => x.id === 'dev')!;
    expect(summary).toMatchObject({ status: 'working', running: 2, queued: 1, maxTasks: 2 });
    // One turn per task: a follow-up to a running task is refused, not run beside it.
    await expect(client.call('tasks.send', { taskId: tasks[0]!.id, text: 'more' })).rejects.toThrow(
      /turn in progress/,
    );
    // A slot that frees up goes to the queued task.
    await client.call('tasks.cancel', { taskId: tasks[0]!.id });
    await client.call('tasks.wait', { taskId: tasks[0]!.id });
    await new Promise((r) => setTimeout(r, 300));
    expect(await status()).toEqual(['cancelled', 'running', 'running']);
  });

  it('cancels a running task', async () => {
    transport.mode = 'slow';
    const { client, daemon } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'x' });
    await new Promise((r) => setTimeout(r, 300));
    await client.call('tasks.cancel', { taskId: task.id });
    const done = await client.call('tasks.wait', { taskId: task.id });
    expect(done.status).toBe('cancelled');
  });

  it('builds a missing recipe image before starting the cell', async () => {
    write('images/node.yaml', 'packages: [nodejs]\n');
    write('agents/dev.yaml', 'runtime: codex\nimage: node\n');
    const { client, daemon } = await start();
    const task = await client.call('tasks.create', { agentId: 'dev', text: 'x' });
    await client.call('tasks.wait', { taskId: task.id });
    const build = transport.execs.find((e) => e.args[1] === 'build')!;
    expect(build.args[2]).toBe('node');
    expect(JSON.parse(build.stdin)).toEqual({ packages: ['nodejs'], run: [] });
    expect(transport.starts[0]![4]).toBe('node');
  });

  it('reaps orphaned cells and fails interrupted tasks on start', async () => {
    const first = await start();
    const task = await first.client.call('tasks.create', { agentId: 'dev', text: 'x' });
    await first.client.call('tasks.wait', { taskId: task.id });
    first.client.close();
    await first.daemon.stop();
    // Simulate a crash mid-turn.
    const { Store } = await import('../src/store.ts');
    const store = new Store(homeLayout(root).dbFile);
    store.setStatus(task.id, 'running');
    store.close();
    const second = await start();
    expect(transport.execs.some((e) => e.args[1] === 'reap')).toBe(true);
    expect((await second.client.call('tasks.get', { taskId: task.id })).status).toBe('failed');
  });

  it('rejects invalid ids and unknown agents', async () => {
    const { client, daemon } = await start();
    await expect(client.call('tasks.get', { taskId: '../x' })).rejects.toThrow(/invalid task id/);
    await expect(client.call('tasks.create', { agentId: 'nope', text: 'x' })).rejects.toThrow(
      /unknown agent/,
    );
  });

  it('verifies a connector after import and removes a refused credential', async () => {
    const { client } = await start();
    const status = await client.call('connectors.set', { id: 'github', token: 'ghp_good' });
    expect(status).toMatchObject({ id: 'github', connected: true, account: 'octo' });
    transport.rejectCredential = true;
    await expect(client.call('connectors.set', { id: 'github', token: 'ghp_bad' })).rejects.toThrow(
      /github did not accept the credential: CREDENTIAL_REJECTED/,
    );
    expect(transport.connected).toBe(false);
    expect(transport.execs.some((e) => e.args.join(' ').includes('ghp_'))).toBe(false);
  });

  it('imports the gh CLI token and verifies it', async () => {
    const { client } = await start();
    await expect(client.call('connectors.importGh')).rejects.toThrow(/not logged in/);
    hostAnswers['gh auth token'] = 'gho_fakefakefakefakefakefake\n';
    const status = await client.call('connectors.importGh');
    expect(status).toMatchObject({ id: 'github', connected: true, account: 'octo' });
    expect(transport.imported.at(-1)).toEqual({
      id: 'github',
      value: { token: 'gho_fakefakefakefakefakefake' },
    });
  });

  it('connects AWS through a host profile and refreshes it before expiry', async () => {
    const { client, daemon } = await start();
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    hostAnswers['aws configure export-credentials'] = JSON.stringify({
      Version: 1,
      AccessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      SecretAccessKey: 'fake/secret',
      SessionToken: 'fake-session',
      Expiration: soon,
    });
    hostAnswers['aws configure get'] = 'us-west-2\n';
    await expect(client.call('connectors.awsProfile', { profile: 'bad name' })).rejects.toThrow(
      /invalid AWS profile/,
    );
    const status = await client.call('connectors.awsProfile', { profile: 'dev-sso' });
    expect(status).toMatchObject({ id: 'aws', connected: true, profile: 'dev-sso' });
    expect(transport.imported.at(-1)!.value).toEqual({
      access_key_id: 'ASIAIOSFODNN7EXAMPLE',
      secret_access_key: 'fake/secret',
      session_token: 'fake-session',
      region: 'us-west-2',
    });
    const before = transport.imported.length;
    await daemon.refreshAws();
    expect(transport.imported.length).toBe(before + 1);
    // Keys entered by hand end the profile refresh.
    await client.call('connectors.set', {
      id: 'aws',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 's',
      region: 'us-east-1',
    });
    hostCalls = [];
    await daemon.refreshAws();
    expect(hostCalls).toEqual([]);
  });

  it('runs setup steps one at a time and streams their output', async () => {
    const { client } = await start();
    const lines: string[] = [];
    client.on('setup', ({ line }) => lines.push(line));
    await expect(client.call('setup.run', { action: 'install' })).rejects.toThrow(
      /install failed: .* exited with 3: broken/,
    );
    expect(lines).toContain('step one');
    await expect(client.call('setup.run', { action: 'nope' as never })).rejects.toThrow(
      /unknown setup step/,
    );
  });

  it('answers Anchi tool calls as the task and agent of the cell', async () => {
    write('agents/lead.yaml', 'runtime: codex\ndelegates: [dev]\n');
    const { client } = await start();
    const reply = async (agentId: string, text: string) => {
      const task = await client.call('tasks.create', { agentId, text });
      const done = await client.call('tasks.wait', { taskId: task.id });
      return { task, answer: JSON.parse(done.result!) as Record<string, unknown> };
    };
    const who = await reply('lead', 'call anchi_whoami');
    expect(who.answer).toMatchObject({ ok: true, result: { agent: 'lead', task: who.task.id } });
    const list = await reply('lead', 'call anchi.tools');
    const names = (list.answer.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['anchi_whoami', 'anchi_list_agents']));
    const agents = await reply('lead', 'call anchi_list_agents');
    expect(agents.answer).toMatchObject({ ok: true, result: { agents: [{ id: 'dev' }] } });
    // dev may not delegate: its list is empty.
    expect((await reply('dev', 'call anchi_list_agents')).answer).toMatchObject({
      result: { agents: [] },
    });
    expect((await reply('dev', 'call no_such_tool')).answer).toMatchObject({
      ok: false,
      error: 'unknown tool no_such_tool',
    });
    expect((await reply('dev', 'call anchi_whoami {"extra":1}')).answer).toMatchObject({
      ok: false,
    });
  });

  it('delegates to allowed agents, links the tree and enforces the limits', async () => {
    write('agents/lead.yaml', 'runtime: codex\ndelegates: [dev, qa]\n');
    write('agents/qa.yaml', 'runtime: codex\ndelegates: [lead]\n');
    const { client } = await start();
    const turn = async (agentId: string, text: string) => {
      const task = await client.call('tasks.create', { agentId, text });
      const done = await client.call('tasks.wait', { taskId: task.id });
      return {
        task: done,
        answer: JSON.parse(done.result!) as { ok: boolean; result?: any; error?: string },
      };
    };
    const lead = await turn('lead', 'call anchi_delegate_task {"agent":"dev","task":"fix it"}');
    expect(lead.answer.ok).toBe(true);
    const child = lead.answer.result;
    expect(child).toMatchObject({
      agent: 'dev',
      status: 'done',
      links: ['https://github.com/o/r/pull/1'],
    });
    const row = await client.call('tasks.get', { taskId: child.task });
    expect(row).toMatchObject({
      parentId: lead.task.id,
      rootId: lead.task.id,
      depth: 1,
      trigger: 'delegation',
    });
    const notices = (await client.call('tasks.events', { taskId: lead.task.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices[0]).toBe(`↳ delegated to @dev as ${child.task}`);
    expect(notices[1]).toContain(`↳ ${child.task} (@dev) done: https://github.com/o/r/pull/1`);
    // Not in delegates, and dev may not delegate at all (the tool is not offered).
    expect(
      (await turn('lead', 'call anchi_delegate_task {"agent":"lead","task":"x"}')).answer.error,
    ).toMatch(/may not delegate/);
    expect(
      (await turn('dev', 'call anchi_delegate_task {"agent":"lead","task":"x"}')).answer.error,
    ).toMatch(/unknown tool/);
    // Status only for the task's own children.
    expect(
      (await turn('lead', `call anchi_task_status {"task":"${child.task}"}`)).answer.error,
    ).toMatch(/not delegated by this task/);
    // qa -> lead -> qa would wait for itself.
    const inner = JSON.stringify({ agent: 'qa', task: 'x' });
    const qa = await turn(
      'qa',
      `call anchi_delegate_task ${JSON.stringify({ agent: 'lead', task: `call anchi_delegate_task ${inner}` })}`,
    );
    expect(qa.answer.ok).toBe(true);
    expect(qa.answer.result.result).toContain('already working on a task above this one');
  });

  it('mirrors held writes, notes them in the task and sends the decision back', async () => {
    const { client: first } = await start();
    const task = await first.call('tasks.create', { agentId: 'dev', text: 'push it' });
    await first.call('tasks.wait', { taskId: task.id });
    await daemon!.stop();
    daemon = undefined;
    first.close();
    transport.approvalLines = [
      JSON.stringify({
        type: 'pending',
        approval: {
          id: 'a'.repeat(16),
          task: task.id,
          agent: 'dev',
          connector: 'github',
          operation: 'POST /o/r.git/git-receive-pack',
          host: 'github.com',
          summary: 'git push: refs/heads/fix',
          created_at: 1,
          timeout: 300,
          reason: 'high-risk: push to main or master',
        },
      }),
      'not json',
      JSON.stringify({ type: 'pending', approval: { id: '../bad' } }),
    ];
    const { client } = await start();
    await new Promise((r) => setTimeout(r, 300));
    const pending = await client.call('approvals.list');
    expect(pending).toEqual([
      expect.objectContaining({
        id: 'a'.repeat(16),
        summary: 'git push: refs/heads/fix',
        createdAt: 1000,
        reason: 'high-risk: push to main or master',
        origin: `you → @dev (${task.id})`,
      }),
    ]);
    const notices = (await client.call('tasks.events', { taskId: task.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices).toContain(
      '⏸ waiting for your approval: POST /o/r.git/git-receive-pack (high-risk: push to main or master)',
    );
    await client.call('approvals.decide', { id: 'a'.repeat(16), allow: true });
    expect(transport.execs.at(-1)!.args).toEqual([
      'anchi-cell',
      'approvals',
      'decide',
      'a'.repeat(16),
      'allow',
    ]);
    await expect(
      client.call('approvals.decide', { id: 'b'.repeat(16), allow: true }),
    ).rejects.toThrow(/unknown/);
  });

  it('shows connector-service writes held by the policy service, verified there', async () => {
    write('agents/writer.yaml', 'runtime: codex\nconnectors: [notion]\n');
    const { client } = await start();
    const turn = async (agentId: string, text: string) => {
      const task = await client.call('tasks.create', { agentId, text });
      const done = await client.call('tasks.wait', { taskId: task.id });
      return JSON.parse(done.result!) as { ok: boolean; error?: string };
    };
    const pending = (id: string, connector = 'notion') =>
      `call anchi.approval_pending ${JSON.stringify({ connector, approval_id: id })}`;
    expect((await turn('writer', pending('c'.repeat(32)))).ok).toBe(true);
    const [a] = await client.call('approvals.list');
    expect(a).toMatchObject({
      kind: 'policy',
      connector: 'notion',
      operation: 'notion.create_page',
      agent: 'writer',
    });
    expect(a!.summary).toContain('"title": "Notes"');
    // An id the policy service does not know, or a connector the agent lacks, is refused.
    expect((await turn('writer', pending('e'.repeat(32)))).ok).toBe(false);
    expect((await turn('writer', pending('c'.repeat(32), 'gmail'))).error).toMatch(
      /not a connector/,
    );
    await client.call('approvals.decide', { id: 'c'.repeat(32), allow: true });
    expect(transport.execs.at(-1)!.args.slice(2)).toEqual([
      'approve',
      'c'.repeat(32),
      '--digest',
      'd'.repeat(64),
    ]);
    expect(await client.call('approvals.list')).toEqual([]);
  });

  it('fires schedules once per due minute and once after a missed run', async () => {
    write(
      'agents/cron.yaml',
      "runtime: codex\ntriggers: [{ schedule: '0 9 * * *', text: 'daily summary' }]\n",
    );
    const { daemon } = await start();
    const at = (h: number, m = 0, d = 7) => new Date(2026, 9, d, h, m).getTime();
    await daemon.triggers.tick(at(8));
    expect(daemon.store.listTasks('cron')).toHaveLength(0);
    await daemon.triggers.tick(at(9, 0));
    await daemon.triggers.tick(at(9, 0, 7) + 20_000);
    expect(daemon.store.listTasks('cron').map((t) => t.trigger)).toEqual(['schedule']);
    // Asleep for two days: one catch-up run, not two.
    await daemon.triggers.tick(at(10, 0, 9));
    expect(daemon.store.listTasks('cron')).toHaveLength(2);
    const [info] = daemon.triggers.list();
    expect(info).toMatchObject({ kind: 'schedule', spec: '0 9 * * *', nextRun: at(9, 0, 10) });
  });

  it('starts one task per new polled item, after a silent first poll', async () => {
    write(
      'agents/triage.yaml',
      "runtime: codex\nconnectors: [linear]\ntriggers: [{ poll: { type: linear-issues, label: agent }, text: 'Handle {title} {url}', every: 1 }]\n",
    );
    const { daemon } = await start();
    const issue = (n: number) => ({
      id: `u${n}`,
      title: `ENG-${n} Bug`,
      url: `https://linear.app/x/issue/ENG-${n}`,
    });
    transport.pollItems = [issue(1)];
    await daemon.triggers.tick(1_000_000);
    expect(daemon.store.listTasks('triage')).toHaveLength(0);
    transport.pollItems = [issue(3), issue(2), issue(1)];
    await daemon.triggers.tick(1_000_000 + 30_000); // not due yet
    await daemon.triggers.tick(1_000_000 + 61_000);
    const titles = daemon.store.listTasks('triage').map((t) => t.title);
    expect(titles.sort()).toEqual([
      'Handle ENG-2 Bug https://linear.app/x/issue/ENG-2',
      'Handle ENG-3 Bug https://linear.app/x/issue/ENG-3',
    ]);
    await daemon.triggers.tick(1_000_000 + 130_000);
    expect(daemon.store.listTasks('triage')).toHaveLength(2);
    expect(daemon.triggers.list()[0]).toMatchObject({ kind: 'poll', lastResult: 'nothing new' });
  });

  it('searches, walks trees, counts usage and deletes tasks with their children', async () => {
    write('agents/lead.yaml', 'runtime: codex\ndelegates: [dev]\n');
    const { client, daemon } = await start();
    const run = async (agentId: string, text: string) => {
      const t = await client.call('tasks.create', { agentId, text });
      return client.call('tasks.wait', { taskId: t.id });
    };
    const plain = await run('dev', 'fix the 100% bug');
    const parent = await run(
      'lead',
      'call anchi_delegate_task {"agent":"dev","task":"child work"}',
    );
    const tree = await client.call('tasks.tree', { taskId: parent.id });
    expect(tree.map((t) => [t.agentId, t.depth])).toEqual([
      ['lead', 0],
      ['dev', 1],
    ]);
    expect((await client.call('tasks.search', { text: '100%' })).map((t) => t.id)).toEqual([
      plain.id,
    ]);
    expect((await client.call('tasks.search', { text: '%' })).map((t) => t.id)).toEqual([plain.id]);
    expect(await client.call('tasks.search', { agentId: 'lead', status: 'done' })).toHaveLength(1);
    expect(await client.call('tasks.search', { since: Date.now() + 1000 })).toEqual([]);
    expect(plain.turns).toBe(1);
    daemon.store.addUsage(plain.id, 1200, 30);
    expect(daemon.store.getTask(plain.id)).toMatchObject({ inputTokens: 1200, outputTokens: 30 });
    // Deleting the parent takes the delegated task; a running task cannot be deleted.
    transport.mode = 'slow';
    const busy = await client.call('tasks.create', { agentId: 'dev', text: 'busy' });
    await new Promise((r) => setTimeout(r, 50));
    await expect(client.call('tasks.delete', { taskId: busy.id })).rejects.toThrow(/still/);
    expect(await client.call('tasks.delete', { taskId: parent.id })).toEqual({ deleted: 2 });
    expect(daemon.store.tree(parent.id)).toEqual([]);
    // Retention removes finished tasks older than the limit.
    expect(daemon.hub.purge(30, Date.now() + 31 * 86_400_000)).toBe(1);
    expect(daemon.store.getTask(plain.id)).toBeUndefined();
  });

  it('sends an agent its skills before a cell starts, only when they change', async () => {
    write('skills/triage/SKILL.md', '---\nname: Triage\ndescription: d\n---\n');
    write('agents/sk.yaml', 'runtime: codex\nskills: [triage]\n');
    write('agents/nosk.yaml', 'runtime: codex\nskills: [missing]\n');
    const { client } = await start();
    const run = async (agentId: string) => {
      const t = await client.call('tasks.create', { agentId, text: 'go' });
      return client.call('tasks.wait', { taskId: t.id });
    };
    await run('sk');
    await run('sk');
    expect(transport.skillSets).toEqual([
      { agent: 'sk', files: ['.claude-plugin/plugin.json', 'skills/triage/SKILL.md'] },
    ]);
    const failed = await run('nosk');
    expect(failed).toMatchObject({
      status: 'failed',
      result: expect.stringMatching(/skill "missing" is not installed/),
    });
  });

  it('binds workspaces and reports code-running paths a turn adds to writable ones', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'anchi-ws-'));
    mkdirSync(join(ws, 'app', '.git', 'hooks'), { recursive: true });
    mkdirSync(join(ws, 'docs'));
    write(
      'agents/coder.yaml',
      'runtime: codex\nworkspaces: [{ path: app, mode: rw }, { path: docs }]\n',
    );
    const { client } = await start(60_000, undefined, ws);
    const t = await client.call('tasks.create', {
      agentId: 'coder',
      text: `write ${join(ws, 'app', '.git', 'hooks', 'post-checkout')}`,
    });
    await client.call('tasks.wait', { taskId: t.id });
    const arg = transport.starts.at(-1)!.at(-3)!;
    expect(JSON.parse(Buffer.from(arg, 'base64url').toString())).toEqual([
      { name: 'app', path: 'app', mode: 'rw' },
      { name: 'docs', path: 'docs', mode: 'ro' },
    ]);
    const notices = (await client.call('tasks.events', { taskId: t.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices).toEqual([
      `⚠ workspace app: ${join('.git', 'hooks', 'post-checkout')}: git hook added or changed`,
    ]);
  });

  it("passes an agent's high-risk exceptions to its cells, and nothing extra otherwise", async () => {
    write(
      'agents/merger.yaml',
      'runtime: codex\nconnectors: [github]\nhighRisk: { disable: [github-merge] }\n',
    );
    const { client } = await start();
    const t = await client.call('tasks.create', { agentId: 'merger', text: 'merge it' });
    await client.call('tasks.wait', { taskId: t.id });
    expect(transport.starts.at(-1)!.slice(-2)).toEqual(['-', 'github-merge']);
    const plain = await client.call('tasks.create', { agentId: 'dev', text: 'hi' });
    await client.call('tasks.wait', { taskId: plain.id });
    expect(transport.starts.at(-1)).toHaveLength(13);
  });

  it('scans every cell before closing it and reports findings', async () => {
    const { client, daemon } = await start(100);
    const found: unknown[] = [];
    daemon.hub.on('scanFinding', (f) => found.push(f));
    const run = async () => {
      const t = await client.call('tasks.create', { agentId: 'dev', text: 'go' });
      await client.call('tasks.wait', { taskId: t.id });
      await new Promise((r) => setTimeout(r, 400)); // idle timeout closes the cell
      return (await client.call('tasks.events', { taskId: t.id })).map((e) => e.event);
    };
    const clean = await run();
    expect(clean.at(-1)).toEqual({
      type: 'notice',
      text: 'credential scan before closing the cell: clean (3 files)',
    });
    transport.scanResult = {
      clean: false,
      findings: [{ credential: 'github.token', where: 'process 12 environ' }],
      files: 3,
    };
    const dirty = await run();
    expect(dirty.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('github.token in process 12 environ'),
    });
    expect(found).toHaveLength(1);
    transport.scanResult = null;
    const failed = await run();
    expect(failed.at(-1)).toMatchObject({
      type: 'notice',
      text: expect.stringContaining('did not complete'),
    });
    expect(transport.scans).toHaveLength(3);
  });

  it('imports a newer Codex login from the Mac, and only a newer one', async () => {
    const { daemon } = await start();
    const login = join(root, 'codex-auth.json');
    const jwt = (exp: number) =>
      `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
    const writeLogin = (exp: number) =>
      writeFileSync(
        login,
        JSON.stringify({
          tokens: { access_token: jwt(exp), account_id: 'acct', refresh_token: 'r' },
        }),
      );
    const now = Math.floor(Date.now() / 1000);
    writeLogin(now + 3600);
    expect(await daemon.syncCodex(login)).toBe(true);
    expect(transport.codexImports).toEqual([{ access_token: jwt(now + 3600), account_id: 'acct' }]);
    expect(await daemon.syncCodex(login)).toBe(false); // same token
    writeLogin(now + 30); // about to expire: not imported
    expect(await daemon.syncCodex(login)).toBe(false);
    writeLogin(now + 7200);
    write('settings.yaml', 'codexAutoImport: false\n');
    expect(await daemon.syncCodex(login)).toBe(false);
    write('settings.yaml', 'codexAutoImport: true\n');
    expect(await daemon.syncCodex(login)).toBe(true);
    expect(transport.codexImports).toHaveLength(2);
  });

  it('accepts a task for an agent file written just before it', async () => {
    const { client } = await start();
    write('agents/fresh.yaml', 'runtime: codex\n');
    const task = await client.call('tasks.create', { agentId: 'fresh', text: 'hello' });
    expect((await client.call('tasks.wait', { taskId: task.id })).status).toBe('done');
  });
});

describe('builder', () => {
  const reply = [
    'Here is the agent.',
    '```anchi-agent id=devops',
    'name: DevOps',
    'runtime: codex',
    'connectors: [aws, github]',
    'image: awscli',
    'prompt:',
    '  text: Read CloudWatch logs and file issues.',
    '```',
    '```anchi-image id=awscli',
    'packages: [unzip]',
    'run: ["echo install aws"]',
    '```',
  ].join('\n');

  it('parses proposal blocks', () => {
    const blocks = parseBlocks(reply);
    expect(blocks.agent?.id).toBe('devops');
    expect(blocks.image?.yaml).toMatch(/unzip/);
  });

  it('turns builder output into a proposal that only apply writes', async () => {
    const { client, daemon } = await start();
    const agents = await client.call('agents.list');
    expect(agents.map((a) => a.id)).toContain('builder');
    const proposal = daemon.proposals.add(parseBlocks(reply))!;
    expect(proposal.errors).toEqual([]);
    expect(proposal.agentDiff).toMatch(/^\+ name: DevOps/m);
    expect(() => readFileSync(join(root, 'agents/devops.yaml'))).toThrow();
    const after = await client.call('builder.apply', { proposalId: proposal.id });
    expect(after.find((a) => a.id === 'devops')?.connectors).toEqual(['aws', 'github']);
    expect(readFileSync(join(root, 'images/awscli.yaml'), 'utf8')).toMatch(/unzip/);
    await expect(client.call('builder.apply', { proposalId: proposal.id })).rejects.toThrow(
      /unknown proposal/,
    );
  });

  it('flags invalid proposals and never writes them', async () => {
    const { client, daemon } = await start();
    for (const bad of [
      '```anchi-agent id=builder\nruntime: codex\n```',
      '```anchi-agent id=x\nruntime: codex\nconnectors: [jira]\n```',
      '```anchi-agent id=x\nruntime: codex\nimage: missing\n```',
      '```anchi-agent id=x\nruntime: codex\nextends: base\n```',
      '```anchi-agent id=x\nruntime: codex\nprompt: { file: /etc/passwd }\n```',
    ]) {
      const proposal = daemon.proposals.add(parseBlocks(bad))!;
      expect(proposal.errors.length, bad).toBeGreaterThan(0);
      await expect(client.call('builder.apply', { proposalId: proposal.id })).rejects.toThrow(
        /invalid/,
      );
    }
  });

  it('runs the builder as a built-in agent and broadcasts its proposal', async () => {
    const { client, daemon } = await start();
    const seen: string[] = [];
    client.on('proposal', ({ proposal }) => seen.push(proposal.agentId));
    // The fake runner echoes the input, so the reply carries the blocks.
    const task = await client.call('tasks.create', { agentId: 'builder', text: reply });
    await client.call('tasks.wait', { taskId: task.id });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['devops']);
    expect(transport.starts[0]![6]).toBe('-');
  });
});

describe('task audit', () => {
  const rows = (task: string) => [
    {
      event: 'register',
      task,
      agent: 'dev',
      grants: ['codex', 'github'],
      egress: ['github.com'],
      ask: ['github'],
      services: ['notion'],
      ts: 1,
    },
    {
      task,
      agent: 'dev',
      method: 'POST',
      host: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      rule: 'codex',
      op: 'POST /backend-api/codex/responses',
      decision: 'inject',
      client_cred: 'placeholder',
      ts: 2,
    },
    {
      task,
      agent: 'dev',
      method: 'GET',
      host: 'api.github.com',
      path: '/repos/o/r',
      rule: 'github-api',
      op: 'GET /repos/o/r',
      decision: 'inject',
      client_cred: 'placeholder',
      ts: 3,
    },
    {
      task,
      agent: 'dev',
      method: 'PUT',
      host: 'api.github.com',
      path: '/repos/o/r/pulls/1/merge',
      rule: 'github-api',
      op: 'PUT /repos/o/r/pulls/1/merge',
      decision: 'held-denied',
      approval: 'denied',
      risk: 'github-merge',
      client_cred: 'placeholder',
      ts: 4,
    },
    {
      task,
      agent: 'dev',
      method: 'GET',
      host: 'registry.npmjs.org',
      path: '/left-pad',
      rule: null,
      op: null,
      decision: 'pass',
      client_cred: 'none',
      ts: 5,
    },
    { decision: 'egress-denied', host: 'example.com', task, agent: 'dev', ts: 6 },
    { event: 'service', service: 'notion', op: 'search', task, agent: 'dev', ts: 7 },
    { event: 'service', service: 'notion', op: 'search', task, agent: 'dev', ts: 8 },
  ];

  it('summarizes what a task reached, what got credentials and what was refused', () => {
    const a = summarizeAudit(
      't-1',
      { rows: rows('t-1'), total: 8, truncated: false },
      'credential scan before closing the cell: clean (12 files)',
    );
    expect(a).toMatchObject({
      cells: 1,
      registration: {
        connectors: ['codex', 'github'],
        egress: ['github.com'],
        ask: ['github'],
        services: ['notion'],
      },
      requests: 4,
      injected: { codex: 1, 'github-api': 1 },
      credentialsSent: { placeholder: 3, none: 1 },
      streamed: 0,
      bridge: [{ service: 'notion', operation: 'search', calls: 2 }],
      held: [
        {
          operation: 'PUT /repos/o/r/pulls/1/merge',
          host: 'api.github.com',
          risk: 'github-merge',
          outcome: 'denied',
        },
      ],
    });
    expect(a.hosts.map((h) => [h.host, h.requests, h.injected])).toEqual([
      ['api.github.com', 2, 1],
      ['chatgpt.com', 1, 1],
      ['registry.npmjs.org', 1, 0],
    ]);
    expect(a.refused.map((r) => [r.host, r.decision])).toEqual([
      ['api.github.com', 'held-denied'],
      ['example.com', 'egress-denied'],
    ]);
    expect(a.rows).toHaveLength(4);
    expect(a.rows[0]).toMatchObject({ ts: 2000, credential: 'placeholder' });
    expect(auditHeadline(a)).toBe(
      '4 requests; 2 with credentials injected by the proxy; the cell sent only placeholders or no credential; 2 refused or held; credential scan before closing the cell: clean (12 files)',
    );
    const leaked = summarizeAudit(
      't-2',
      { rows: [{ ...rows('t-2')[2], client_cred: 'other' }], total: 1, truncated: false },
      null,
    );
    expect(auditHeadline(leaked)).toContain(
      'the cell sent something other than a placeholder 1 time',
    );
  });

  it("saves a task's rows when its cell closes, so they outlive the log", async () => {
    const { client } = await start(100);
    const t = await client.call('tasks.create', { agentId: 'dev', text: 'hello' });
    transport.auditRows = rows(t.id);
    await client.call('tasks.wait', { taskId: t.id });
    await new Promise((r) => setTimeout(r, 400)); // idle timeout closes the cell
    transport.auditRows = [rows(t.id)[1]!]; // the rest rotated away
    const a = await client.call('tasks.audit', { taskId: t.id });
    expect(a).toMatchObject({ requests: 4, total: 8, truncated: false });
    expect(a.savedOnly).toBeUndefined();
    transport.auditFails = true;
    expect(await client.call('tasks.audit', { taskId: t.id })).toMatchObject({
      requests: 4,
      savedOnly: true,
    });
    await client.call('tasks.delete', { taskId: t.id });
    expect(daemon!.store.auditRows(t.id)).toEqual([]);
  });

  it('keeps saved rows once each, and only the latest per task', () => {
    const store = new Store(join(root, 'audit.db'));
    const row = (ts: number) => ({ task: 't-1', method: 'GET', host: 'h', ts });
    store.saveAuditRows('t-1', [row(1), row(2)]);
    store.saveAuditRows('t-1', [row(2), row(3)]);
    expect(store.auditRows('t-1').map((r) => r.ts)).toEqual([1, 2, 3]);
    store.saveAuditRows(
      't-1',
      Array.from({ length: AUDIT_SAVED_MAX }, (_, i) => row(10 + i)),
    );
    const kept = store.auditRows('t-1');
    expect(kept).toHaveLength(AUDIT_SAVED_MAX);
    expect(kept[0]!.ts).toBe(10);
    store.close();
  });

  it('fails to read the access of a task with nothing saved while the VM is unreachable', async () => {
    const { client } = await start();
    const t = await client.call('tasks.create', { agentId: 'dev', text: 'hello' });
    await client.call('tasks.wait', { taskId: t.id });
    transport.auditFails = true;
    await expect(client.call('tasks.audit', { taskId: t.id })).rejects.toThrow();
  });

  it('notes and reports at once a credential a cell sent of its own', async () => {
    const { client: first } = await start();
    const t = await first.call('tasks.create', { agentId: 'dev', text: 'hello' });
    await first.call('tasks.wait', { taskId: t.id });
    await daemon!.stop();
    daemon = undefined;
    first.close();
    transport.approvalLines = [
      JSON.stringify({
        type: 'credential',
        task: t.id,
        agent: 'dev',
        method: 'GET',
        host: 'api.example.com',
        path: '/v1/me',
      }),
      JSON.stringify({ type: 'credential', task: 't-unknown', host: 'x' }),
      JSON.stringify({
        type: 'notice',
        task: t.id,
        text: '⛔ git push refused: update refs/heads/main',
      }),
      JSON.stringify({ type: 'notice', task: t.id, text: 7 }),
    ];
    const { client } = await start();
    await new Promise((r) => setTimeout(r, 300));
    const notices = (await client.call('tasks.events', { taskId: t.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices).toContain(
      '⚠ the cell sent a credential of its own (not an Anchi placeholder) to api.example.com: GET /v1/me',
    );
    expect(notices).toContain('⛔ git push refused: update refs/heads/main');
  });

  it('sums up the access of every task over a period', async () => {
    const { client } = await start();
    const one = await client.call('tasks.create', { agentId: 'dev', text: 'one' });
    await client.call('tasks.wait', { taskId: one.id });
    const two = await client.call('tasks.create', { agentId: 'dev', text: 'two' });
    await client.call('tasks.wait', { taskId: two.id });
    const now = Date.now() / 1000;
    const own = {
      task: two.id,
      agent: 'dev',
      method: 'GET',
      host: 'api.example.com',
      path: '/me',
      decision: 'pass',
      client_cred: 'other',
      ts: now,
    };
    const old = { ...own, task: one.id, ts: now - 30 * 86_400 }; // outside the period
    const gmail = {
      event: 'service',
      service: 'gmail',
      op: 'gmail.list',
      task: two.id,
      agent: 'dev',
      account: 'work',
      ts: now,
    };
    transport.auditRows = [
      ...rows(one.id).map((r) => ({ ...r, ts: now })),
      own,
      old,
      gmail,
      { ...gmail, op: 'gmail.read', ts: now + 1 },
      { ...gmail, op: 'gmail.read', ts: now + 2 },
    ];
    const s = await client.call('access.summary', { since: Date.now() - 86_400_000 });
    expect(s).toMatchObject({ tasks: 2, partial: false });
    expect(s.agents).toEqual([
      expect.objectContaining({
        agent: 'dev',
        tasks: 2,
        requests: 5,
        credentialsOther: 1,
        injected: { codex: 1, 'github-api': 1 },
        services: 4,
      }),
    ]);
    expect(s.services).toEqual([
      { service: 'gmail', operation: 'gmail.read', account: 'work', calls: 2, agents: ['dev'] },
      { service: 'notion', operation: 'search', account: null, calls: 1, agents: ['dev'] },
      { service: 'gmail', operation: 'gmail.list', account: 'work', calls: 1, agents: ['dev'] },
    ]);
    expect(s.credentials.map((r) => [r.task, r.host])).toEqual([[two.id, 'api.example.com']]);
    expect(s.hosts[0]).toMatchObject({ host: 'api.github.com', agents: ['dev'] });
    transport.auditFails = true;
    expect(await client.call('access.summary', {})).toMatchObject({ partial: true, tasks: 2 });
  });

  it('serves a task audit and the latest quota over RPC', async () => {
    const { client } = await start();
    const t = await client.call('tasks.create', { agentId: 'dev', text: 'hello' });
    await client.call('tasks.wait', { taskId: t.id });
    transport.auditRows = [...rows(t.id), ...rows('t-other')];
    const a = await client.call('tasks.audit', { taskId: t.id });
    expect(a).toMatchObject({ taskId: t.id, requests: 4, total: 8 });
    expect(transport.execs.some((e) => e.args.join(' ') === `anchi-cell audit ${t.id}`)).toBe(true);
    await expect(client.call('tasks.audit', { taskId: '../x' })).rejects.toThrow();
    expect(await client.call('usage.quota')).toEqual([
      {
        runtime: 'codex',
        ts: 1791500000500,
        status: 200,
        headers: {},
        plan: 'team',
        limited: false,
        windows: [{ name: 'primary', usedPercent: 40, windowMinutes: 300, resetAt: 1791500157000 }],
      },
      { runtime: 'claude-code', ts: 1791500001000, status: 429, headers: { 'retry-after': '120' } },
    ]);
  });
});

describe('token usage', () => {
  const zero = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };

  it('turns running totals into per-turn amounts and sums turns into totals', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'anchi-usage-')), 'a.db'));
    const t = store.createTask({ agentId: 'dev', trigger: 'user', title: 'x' });
    const row = { taskId: t.id, agentId: 'dev', runtime: 'claude-code', model: 'opus' };
    expect(
      store.recordUsage(row, { ...zero, input: 100, output: 10, costUsd: 0.5 }, true),
    ).toMatchObject({
      input: 100,
      output: 10,
      costUsd: 0.5,
    });
    expect(
      store.recordUsage(row, { ...zero, input: 150, output: 25, costUsd: 0.75 }, true),
    ).toMatchObject({
      input: 50,
      output: 15,
      costUsd: 0.25,
    });
    // A cleared session starts its totals again: counted from zero.
    expect(store.recordUsage(row, { ...zero, input: 20, output: 5 }, true)).toMatchObject({
      input: 20,
      output: 5,
    });
    // Nothing new: no row.
    store.recordUsage(row, { ...zero, input: 20, output: 5 }, true);
    const codex = { taskId: t.id, agentId: 'ops', runtime: 'codex', model: 'gpt-5.5' };
    store.recordUsage(codex, { ...zero, input: 1000, cachedInput: 800, output: 40, reasoning: 12 });
    store.recordUsage(codex, { ...zero, input: 500, cachedInput: 100, output: 10 }, false);
    expect(store.getTask(t.id)).toMatchObject({ inputTokens: 1670, outputTokens: 80 });
    const byModel = store.usageSummary(0, 'model');
    expect(byModel.map((r) => [r.key, r.turns, r.inputTokens, r.outputTokens])).toEqual([
      ['gpt-5.5', 2, 1500, 50],
      ['opus', 3, 170, 30],
    ]);
    expect(byModel[0]).toMatchObject({ cachedInputTokens: 900, reasoningTokens: 12 });
    expect(byModel[1]!.costUsd).toBeCloseTo(0.75);
    expect(store.usageSummary(0, 'agent').map((r) => r.key)).toEqual(['ops', 'dev']);
    expect(store.usageSummary(0, 'day')).toHaveLength(1);
    expect(store.usageSummary(Date.now() + 1000, 'agent')).toEqual([]);
    // Deleting the task keeps the totals.
    store.deleteTasks([t.id]);
    expect(
      store
        .usageSummary(0, 'runtime')
        .map((r) => r.key)
        .sort(),
    ).toEqual(['claude-code', 'codex']);
  });

  it('records the usage a turn reports, with the agent runtime and model', async () => {
    write('agents/dev.yaml', 'runtime: codex\nmodel: gpt-5.5\n');
    const { client } = await start();
    const report = [
      { inputTokens: 300, outputTokens: 20, cachedInputTokens: 200, reasoningTokens: 5 },
    ];
    const t = await client.call('tasks.create', {
      agentId: 'dev',
      text: `usage ${JSON.stringify(report)}`,
    });
    expect(await client.call('tasks.wait', { taskId: t.id })).toMatchObject({
      inputTokens: 300,
      outputTokens: 20,
    });
    expect(await client.call('usage.summary', { by: 'model' })).toEqual([
      {
        key: 'gpt-5.5',
        turns: 1,
        inputTokens: 300,
        cachedInputTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 5,
        costUsd: 0,
      },
    ]);
    expect((await client.call('usage.summary', { by: 'runtime' }))[0]?.key).toBe('codex');
    await expect(client.call('usage.summary', { by: 'host' as never })).rejects.toThrow(
      /unknown grouping/,
    );
  });
});

describe('deleting agents', () => {
  it("purges the VM only once the agent's idle cells have exited", async () => {
    write('agents/dev.yaml', 'runtime: codex\n');
    const { client } = await start();
    const t = await client.call('tasks.create', { agentId: 'dev', text: 'hello' });
    await client.call('tasks.wait', { taskId: t.id });
    writeFileSync(join(root, 'exit-ms'), '500'); // a cell takes a moment to release its overlay
    const done = await client.call('agents.delete', { agentId: 'dev', confirm: 'dev' });
    expect(done.vm).not.toBeNull();
    expect(transport.purgedWhileRunning).toBe(false);
  });

  it('deletes an agent with its task trees, cancelling running work, and edits its delegators', async () => {
    write('agents/lead.yaml', '# the lead\nruntime: codex\ndelegates: [dev, qa] # team\n');
    write(
      'agents/dev.yaml',
      'runtime: codex\ndelegates: [qa]\nworkspaces: [{ path: projects/web, mode: rw }]\n',
    );
    write('agents/qa.yaml', 'runtime: codex\n');
    mkdirSync(join(root, 'ws/projects/web'), { recursive: true });
    writeFileSync(join(root, 'ws/projects/web/keep.txt'), 'mine');
    const { client } = await start(60_000, undefined, join(root, 'ws'));
    const turn = async (agentId: string, text: string) => {
      const task = await client.call('tasks.create', { agentId, text });
      return client.call('tasks.wait', { taskId: task.id });
    };
    const lead = await turn('lead', 'call anchi_delegate_task {"agent":"dev","task":"fix it"}');
    const own = await turn('dev', 'call anchi_delegate_task {"agent":"qa","task":"check it"}');
    transport.mode = 'slow';
    const busy = await client.call('tasks.create', { agentId: 'dev', text: 'long job' });
    await new Promise((r) => setTimeout(r, 300));
    const all = await client.call('tasks.list', { limit: 50 });
    const fromLead = all.find((t) => t.parentId === lead.id)!;
    const toQa = all.find((t) => t.parentId === own.id)!;

    expect(await client.call('agents.deletePreview', { agentId: 'dev' })).toEqual({
      agentId: 'dev',
      exists: true,
      tasks: 3,
      delegated: 1,
      running: 1,
      delegatedBy: ['lead'],
      triggers: 0,
      workspaces: ['projects/web'],
    });
    await expect(client.call('agents.delete', { agentId: 'dev', confirm: 'yes' })).rejects.toThrow(
      /type the agent id "dev"/,
    );
    const done = await client.call('agents.delete', { agentId: 'dev', confirm: 'dev' });
    expect(transport.purgedWhileRunning).toBe(false);
    expect(done).toEqual({
      agentId: 'dev',
      deletedTasks: 4,
      editedAgents: ['lead'],
      vm: { agent: 'dev', home: true, skills: true, policy: ['notion:dev'] },
      warnings: [],
    });

    for (const t of [fromLead, own, toQa, busy]) {
      await expect(client.call('tasks.get', { taskId: t.id })).rejects.toThrow();
    }
    expect(existsSync(join(root, 'agents/dev.yaml'))).toBe(false);
    expect(readFileSync(join(root, 'agents/lead.yaml'), 'utf8')).toBe(
      '# the lead\nruntime: codex\ndelegates: [qa] # team\n',
    );
    // The lead's task survives, with a note of what went.
    const notices = (await client.call('tasks.events', { taskId: lead.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices.at(-1)).toBe(`delegated task ${fromLead.id} (@dev) was deleted with @dev`);
    expect((await client.call('agents.list')).map((a) => a.id)).not.toContain('dev');
    await expect(client.call('tasks.create', { agentId: 'dev', text: 'x' })).rejects.toThrow(
      /unknown agent/,
    );
    expect(transport.execs.some((e) => e.args.join(' ') === 'anchi-cell purge-agent dev')).toBe(
      true,
    );
    // The Mac's directory was only ever bound into cells; it is left as it was.
    expect(readFileSync(join(root, 'ws/projects/web/keep.txt'), 'utf8')).toBe('mine');
  });

  it('finishes the VM part on a later run when the VM is down, and refuses the builder', async () => {
    write('agents/qa.yaml', 'runtime: codex\n');
    const { client } = await start();
    transport.purgeFails = true;
    const first = await client.call('agents.delete', { agentId: 'qa', confirm: 'qa' });
    expect(first.vm).toBeNull();
    expect(first.warnings[0]).toMatch(/the VM kept @qa's home and skills .*delete @qa again/);
    expect(existsSync(join(root, 'agents/qa.yaml'))).toBe(false);
    transport.purgeFails = false;
    expect(await client.call('agents.deletePreview', { agentId: 'qa' })).toMatchObject({
      exists: false,
      tasks: 0,
    });
    const again = await client.call('agents.delete', { agentId: 'qa', confirm: 'qa' });
    expect(again).toMatchObject({ deletedTasks: 0, vm: { home: true }, warnings: [] });
    await expect(
      client.call('agents.delete', { agentId: 'builder', confirm: 'builder' }),
    ).rejects.toThrow(/built in/);
    await expect(client.call('agents.deletePreview', { agentId: '../x' })).rejects.toThrow(
      /invalid agent id/,
    );
  });
});

describe('agent settings', () => {
  function workspaceTree() {
    const ws = join(root, 'ws');
    for (const d of ['projects/webapp/src', 'docs', '.hidden'])
      mkdirSync(join(ws, d), { recursive: true });
    write('skills/review/SKILL.md', '---\nname: review\ndescription: Reviews pull requests\n---\n');
    return ws;
  }

  it("adds a refused host to an agent's egress list, and nothing else", async () => {
    write(
      'agents/dev.yaml',
      '# dev\nruntime: codex\negress: [registry.npmjs.org, "*.pypi.org"] # hosts\n',
    );
    write('agents/open.yaml', 'runtime: codex\n');
    const { client } = await start();
    expect(await client.call('agents.allowHost', { agentId: 'dev', host: 'Example.COM.' })).toEqual(
      {
        egress: ['registry.npmjs.org', '*.pypi.org', 'example.com'],
      },
    );
    expect(readFileSync(join(root, 'agents/dev.yaml'), 'utf8')).toBe(
      '# dev\nruntime: codex\negress: [registry.npmjs.org, "*.pypi.org", example.com] # hosts\n',
    );
    for (const [agentId, host, message] of [
      ['dev', 'files.pypi.org', 'already'],
      ['dev', '*.evil.com', 'wildcards'],
      ['dev', 'evil.com/x', 'one host name'],
      ['open', 'example.com', 'any public host'],
      ['builder', 'example.com', 'built in'],
    ] as const) {
      await expect(client.call('agents.allowHost', { agentId, host })).rejects.toThrow(message);
    }
  });

  it('shows settings and what exists, previews a patch and applies only the reviewed one', async () => {
    write('agents/dev.yaml', '# my developer\nruntime: codex\nconnectors: [github] # pushes\n');
    const { client } = await start(60_000, undefined, workspaceTree());
    const settings = await client.call('agents.settings', { agentId: 'dev' });
    expect(settings.current).toEqual({
      name: 'dev',
      description: '',
      runtime: 'codex',
      model: '',
      effort: '',
      prompt: { mode: 'append', text: '' },
      skills: [],
      connectors: ['github'],
      workspaces: [],
    });
    expect(settings).toMatchObject({ inherited: [], fixed: { image: 'codex', egress: null } });
    expect(settings.inventory.skills.map((s) => s.id)).toEqual(['review']);
    expect(settings.inventory.workspaces.dirs).toEqual(['docs', 'projects', 'projects/webapp']);
    expect(settings.inventory.agents).toEqual(['dev']);

    const patch = {
      skills: ['review'],
      workspaces: [{ path: 'projects/webapp', mode: 'rw' as const }],
    };
    const preview = await client.call('agents.update', { agentId: 'dev', patch });
    expect(preview).toMatchObject({ applied: false, errors: [] });
    expect(preview.diff).toMatch(/^\+ skills: \[review\]$/m);
    expect(readFileSync(join(root, 'agents/dev.yaml'), 'utf8')).not.toMatch(/skills/);

    const done = await client.call('agents.update', {
      agentId: 'dev',
      patch,
      apply: true,
      base: preview.base,
    });
    expect(done.applied).toBe(true);
    const text = readFileSync(join(root, 'agents/dev.yaml'), 'utf8');
    expect(text).toMatch(/^# my developer/);
    expect(text).toMatch(/connectors: \[github\] # pushes/);
    const agents = await client.call('agents.list');
    expect(agents.find((a) => a.id === 'dev')?.workspaces).toEqual(['webapp (rw)']);
    // The diff was made against the old file: applying it again is refused.
    await expect(
      client.call('agents.update', { agentId: 'dev', patch, apply: true, base: preview.base }),
    ).rejects.toThrow(/changed since you reviewed it/);
  });

  it('blocks references to what does not exist and refuses invalid patches', async () => {
    const { client } = await start(60_000, undefined, workspaceTree());
    const bad = await client.call('agents.update', {
      agentId: 'dev',
      patch: { skills: ['missing'], workspaces: [{ path: 'nowhere', mode: 'ro' }] },
    });
    expect(bad.errors).toEqual([
      'skill "missing" is not installed',
      'workspace "nowhere" is not a directory under ~/AnchiWorkspaces',
    ]);
    await expect(
      client.call('agents.update', {
        agentId: 'dev',
        patch: { skills: ['missing'] },
        apply: true,
        base: bad.base,
      }),
    ).rejects.toThrow(/cannot save/);
    await expect(
      client.call('agents.update', { agentId: 'dev', patch: { connectors: ['jira'] } }),
    ).rejects.toThrow(/invalid settings/);
    await expect(
      client.call('agents.update', { agentId: 'dev', patch: { skills: ['a', 'a'] } }),
    ).rejects.toThrow(/twice/);
    await expect(
      client.call('agents.update', { agentId: 'builder', patch: { skills: [] } }),
    ).rejects.toThrow(/built in/);
    expect(await client.call('agents.settings', { agentId: 'builder' })).toMatchObject({
      editable: false,
    });
  });

  it('gives the builder the inventory each turn and checks and revises its proposals', async () => {
    const { client, daemon } = await start(60_000, undefined, workspaceTree());
    const task = await client.call('tasks.create', { agentId: 'builder', text: 'hello' });
    await client.call('tasks.wait', { taskId: task.id });
    const events = await client.call('tasks.events', { taskId: task.id });
    // The runtime got the inventory; the transcript shows only what the user typed.
    expect(events.find((e) => e.event.type === 'input')?.event).toMatchObject({ text: 'hello' });
    const said = events.find((e) => e.event.type === 'message')?.event as { text: string };
    expect(said.text).toContain('<anchi-inventory>');
    expect(said.text).toContain('- review: Reviews pull requests');
    expect(said.text).toContain('projects/webapp');
    expect(said.text).toMatch(/Runtimes \(runtime: \.\.\.\): codex \(\w[\w ]*\), claude-code \(/);

    const missing = daemon.proposals.add(
      parseBlocks('```anchi-agent id=rev\nruntime: codex\nskills: [nope]\ndelegates: [ghost]\n```'),
    )!;
    expect(missing.errors).toEqual([
      'skill "nope" is not installed',
      'delegate "ghost" is not an agent',
    ]);

    // A proposal that gives up approvals says so before the user confirms it.
    const risky = daemon.proposals.add(
      parseBlocks(
        '```anchi-agent id=rev\nruntime: codex\nconnectors: [github]\nhighRisk: { disable: [github-merge, git-ref-delete] }\n```',
      ),
    )!;
    expect(risky.errors).toEqual([]);
    expect(risky.warnings).toContain(
      'the agent does github-merge, git-ref-delete without asking you (highRisk)',
    );

    const proposal = daemon.proposals.add(
      parseBlocks('```anchi-agent id=rev\nruntime: codex # ok\n```'),
    )!;
    const revised = await client.call('builder.revise', {
      proposalId: proposal.id,
      patch: { skills: ['review'], connectors: ['github'] },
    });
    expect(revised.id).toBe(proposal.id);
    expect(revised.errors).toEqual([]);
    expect(revised.agentYaml).toBe('runtime: codex # ok\nskills: [review]\nconnectors: [github]\n');
    expect(
      (await client.call('agents.settings', { proposalId: proposal.id })).current.skills,
    ).toEqual(['review']);
    await client.call('builder.apply', { proposalId: proposal.id });
    expect(readFileSync(join(root, 'agents/rev.yaml'), 'utf8')).toMatch(/skills: \[review\]/);
  });

  it('edits name, runtime, model, effort and prompt, over inherited values, and blocks what does not resolve', async () => {
    write('templates/base.yaml', 'runtime: codex\nmodel: gpt-5.5\nprompt:\n  text: Be careful.\n');
    write('agents/dev.yaml', '# mine\nextends: base\nconnectors: [github] # pushes\n');
    write('agents/sb.yaml', 'runtime: codex\nsandbox: codex-workspace-write\n');
    write('agents/m.yaml', 'runtime: codex\nmodel: gpt-5.5 # fast\neffort: high\n');
    write('agents/pf.yaml', 'runtime: codex\nprompt: { file: pf.md }\n');
    write('agents/pf.md', 'From a file.\n');
    const { client } = await start();
    const settings = await client.call('agents.settings', { agentId: 'dev' });
    expect(settings.current).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5.5',
      prompt: { mode: 'append', text: 'Be careful.' },
    });
    expect(settings.inherited).toEqual(['runtime', 'model', 'prompt']);
    expect(settings.fixed).toMatchObject({ extends: 'base', sandbox: 'cell', triggers: [] });

    const patch = {
      name: 'Developer',
      runtime: 'claude-code' as const,
      model: 'claude-sonnet-5-5',
      prompt: { mode: 'replace' as const, text: 'Line one.\nLine two.\n' },
    };
    const preview = await client.call('agents.update', { agentId: 'dev', patch });
    expect(preview.errors).toEqual([]);
    expect(preview.diff).toMatch(/^\+ runtime: claude-code$/m);
    expect(preview.diff).toMatch(/^\+ {3}text: \|\n\+ {5}Line one\.\n\+ {5}Line two\.$/m);
    await client.call('agents.update', { agentId: 'dev', patch, apply: true, base: preview.base });
    expect(readFileSync(join(root, 'agents/dev.yaml'), 'utf8')).toBe(
      [
        '# mine',
        'name: Developer',
        'extends: base',
        'runtime: claude-code',
        'model: claude-sonnet-5-5',
        'prompt:',
        '  mode: replace',
        '  text: |',
        '    Line one.',
        '    Line two.',
        'connectors: [github] # pushes',
        '',
      ].join('\n'),
    );
    const after = await client.call('agents.settings', { agentId: 'dev' });
    expect(after.current.prompt).toEqual({ mode: 'replace', text: 'Line one.\nLine two.\n' });
    expect(after.inherited).toEqual([]);

    // Empty removes the key; the runtime default applies again.
    const cleared = await client.call('agents.update', {
      agentId: 'm',
      patch: { model: '', effort: '' },
    });
    expect(cleared.diff).toBe('  runtime: codex\n- model: gpt-5.5 # fast\n- effort: high');

    const blocked = await client.call('agents.update', {
      agentId: 'sb',
      patch: { runtime: 'claude-code' },
    });
    expect(blocked.errors.join()).toMatch(/needs runtime codex/);
    await expect(
      client.call('agents.update', {
        agentId: 'sb',
        patch: { runtime: 'claude-code' },
        apply: true,
        base: blocked.base,
      }),
    ).rejects.toThrow(/cannot save/);
    for (const bad of [
      { model: 'gpt 5' },
      { effort: 'max' },
      { runtime: 'gemini' },
      { image: 'x' },
    ]) {
      await expect(
        client.call('agents.update', { agentId: 'm', patch: bad as never }),
      ).rejects.toThrow(/invalid settings/);
    }

    const pf = await client.call('agents.settings', { agentId: 'pf' });
    expect(pf.fixed.promptFile).toBe('pf.md');
    expect(pf.current.prompt.text).toBe('From a file.\n');
    await expect(
      client.call('agents.update', { agentId: 'pf', patch: { prompt: { text: 'x' } } }),
    ).rejects.toThrow(/prompt comes from a file/);
  });

  it('shows the builder agent files the user names and turns its patches into update proposals', async () => {
    write('agents/dev.yaml', '# my developer\nruntime: codex # rt\nconnectors: [github]\n');
    const { client, daemon } = await start(60_000, undefined, workspaceTree());
    const said = async (text: string) => {
      const task = await client.call('tasks.create', { agentId: 'builder', text });
      await client.call('tasks.wait', { taskId: task.id });
      const events = await client.call('tasks.events', { taskId: task.id });
      return (events.find((e) => e.event.type === 'message')?.event as { text: string }).text;
    };
    const plain = await said('hello');
    expect(plain).toContain('- dev: "dev": runtime codex, connectors github');
    expect(plain).not.toContain('<agent-file');
    const named = await said('give @dev the review skill');
    expect(named).toContain('<agent-file id="dev">\n# my developer\nruntime: codex # rt');

    const patch = (yaml: string, extra = '') =>
      daemon.proposals.add(parseBlocks(`\`\`\`anchi-agent-patch id=dev\n${yaml}\n\`\`\`${extra}`))!;
    const proposal = patch('model: gpt-5.5\nskills: [review]');
    expect(proposal).toMatchObject({ kind: 'update', errors: [], warnings: [] });
    expect(proposal.agentDiff).toBe(
      '  # my developer\n  runtime: codex # rt\n+ model: gpt-5.5\n  connectors: [github]\n+ skills: [review]',
    );
    expect(readFileSync(join(root, 'agents/dev.yaml'), 'utf8')).not.toMatch(/model/);
    expect((await client.call('agents.settings', { proposalId: proposal.id })).current.model).toBe(
      'gpt-5.5',
    );
    const revised = await client.call('builder.revise', {
      proposalId: proposal.id,
      patch: { effort: 'high' },
    });
    expect(revised).toMatchObject({ id: proposal.id, kind: 'update', errors: [] });
    expect(revised.patch).toEqual({ model: 'gpt-5.5', skills: ['review'], effort: 'high' });
    await client.call('builder.apply', { proposalId: proposal.id });
    expect(readFileSync(join(root, 'agents/dev.yaml'), 'utf8')).toBe(
      '# my developer\nruntime: codex # rt\nmodel: gpt-5.5\neffort: high\nconnectors: [github]\nskills: [review]\n',
    );

    // The file changed after the proposal: applying it is refused.
    const stale = patch('model: ""');
    expect(stale.errors).toEqual([]);
    write('agents/dev.yaml', 'runtime: codex\n');
    await expect(client.call('builder.apply', { proposalId: stale.id })).rejects.toThrow(
      /changed since this proposal; ask the builder again/,
    );

    expect(patch('triggers: []').errors.join()).toMatch(/send a complete anchi-agent block/);
    expect(patch('skills: [nope]').errors).toEqual(['skill "nope" is not installed']);
    expect(patch('runtime: codex').errors).toEqual(['the patch changes nothing']);
    expect(patch('model: x', '\n```anchi-image id=img\npackages: [jq]\n```').errors.join()).toMatch(
      /cannot add an image/,
    );
    const ghost = daemon.proposals.add(
      parseBlocks('```anchi-agent-patch id=ghost\nmodel: x\n```'),
    )!;
    expect(ghost.errors.join()).toMatch(/does not exist/);
    // The last agent or patch block wins; a full block for an existing agent replaces its file.
    const blocks = parseBlocks(
      '```anchi-agent-patch id=dev\nmodel: x\n```\n```anchi-agent id=dev\nruntime: codex\n```',
    );
    expect(blocks.patch).toBeUndefined();
    expect(daemon.proposals.add(blocks)?.kind).toBe('replace');
  });
});

describe('helpers', () => {
  it('diffs lines', () => {
    expect(lineDiff('a\nb\n', 'a\nc\n')).toBe('  a\n- b\n+ c');
    expect(lineDiff('', 'x\n')).toBe('+ x');
  });

  it('extracts links without trailing punctuation', () => {
    expect(extractLinks('PR: https://github.com/o/r/pull/2. Issue (https://x.dev/i/1)')).toEqual([
      'https://github.com/o/r/pull/2',
      'https://x.dev/i/1',
    ]);
  });
});

describe('cell limit', () => {
  afterEach(() => {
    roomWaitMs = undefined;
  });

  const busy = async (client: DaemonClient, n: number) => {
    for (let i = 1; i <= n; i++) write(`agents/a${i}.yaml`, 'runtime: codex\n');
    transport.mode = 'slow';
    const tasks: TaskRow[] = [];
    for (let i = 1; i <= 4; i++)
      tasks.push(await client.call('tasks.create', { agentId: `a${i}`, text: 'long' }));
    await new Promise((r) => setTimeout(r, 300));
    return tasks;
  };

  it('waits for a free cell, counting cells still closing, instead of failing', async () => {
    const { client } = await start();
    const [first] = await busy(client, 5);
    transport.mode = 'ok';
    writeFileSync(join(root, 'exit-ms'), '400'); // a cancelled cell takes a moment to go
    const fifth = await client.call('tasks.create', { agentId: 'a5', text: 'hello' });
    await new Promise((r) => setTimeout(r, 200));
    expect((await client.call('tasks.get', { taskId: fifth.id })).status).not.toBe('done');
    await client.call('tasks.cancel', { taskId: first!.id });
    const done = await client.call('tasks.wait', { taskId: fifth.id });
    expect(done.status).toBe('done');
    expect(transport.maxLive).toBe(4);
    const notices = (await client.call('tasks.events', { taskId: fifth.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices).toContain('waiting for a free cell: 4 are in use');
  });

  it('fails a task that waited too long for a cell', async () => {
    roomWaitMs = 300;
    const { client } = await start();
    await busy(client, 5);
    const fifth = await client.call('tasks.create', { agentId: 'a5', text: 'hello' });
    const done = await client.call('tasks.wait', { taskId: fifth.id });
    expect(done.status).toBe('failed');
    expect(done.result ?? '').toContain('stayed busy');
  });
});

describe('quota alerts', () => {
  it('notifies once per threshold and window period, and once when a limit is reached', async () => {
    let clock = 0;
    let quota: QuotaInfo[] = [];
    const sent: string[] = [];
    const alerts = new QuotaAlerts(
      async () => quota,
      (title) => sent.push(title),
      () => clock,
    );
    const codex = (used: number, resetAt = 1_000_000, limited = false): QuotaInfo => ({
      runtime: 'codex',
      ts: 0,
      status: 200,
      headers: {},
      plan: 'team',
      limited,
      windows: [{ name: 'primary', usedPercent: used, windowMinutes: 300, resetAt }],
    });
    const step = async (q: QuotaInfo[]) => {
      quota = q;
      clock += 61_000;
      return alerts.check();
    };
    expect(await step([codex(40)])).toEqual([]);
    expect(await step([codex(81)])).toEqual(['Anchi: Codex 5-hour window 81% used']);
    expect(await step([codex(90)])).toEqual([]);
    // Within a minute of the last check, nothing is read.
    quota = [codex(97)];
    expect(await alerts.check()).toEqual([]);
    expect(await step([codex(97)])).toEqual(['Anchi: Codex 5-hour window 97% used']);
    expect(await step([codex(100, 1_000_000, true)])).toEqual(['Anchi: Codex limit reached']);
    expect(await step([codex(100, 1_000_000, true)])).toEqual([]);
    // A new window period starts over.
    expect(await step([codex(85, 2_000_000)])).toEqual(['Anchi: Codex 5-hour window 85% used']);
    expect(
      await step([{ runtime: 'claude-code', ts: 3_600_000, status: 429, headers: {} }]),
    ).toEqual(['Anchi: Claude Code limit reached']);
    expect(sent).toHaveLength(5);
  });
});
