import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeLayout } from '@anchi/core';
import type { TaskRow } from '@anchi/protocol';
import {
  Daemon,
  DaemonClient,
  type ExecResult,
  Guest,
  type GuestTransport,
  LimaTransport,
  lineDiff,
  parseBlocks,
} from '../src/index.ts';
import { extractLinks } from '../src/store.ts';

const RUNNER = join(import.meta.dirname, 'fixtures/fake-runner.mjs');

class FakeTransport implements GuestTransport {
  mode = 'ok';
  starts: string[][] = [];
  execs: { args: string[]; stdin: string }[] = [];
  images = new Set(['codex@base']);

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
    return spawn(process.execPath, [RUNNER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_MODE: this.mode },
    });
  }

  async exec(args: string[], stdin = ''): Promise<ExecResult> {
    this.execs.push({ args, stdin });
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
    if (args[0] === 'anchi-cell' && args[1] === 'reap') return ok({ reaped: ['t-old'] });
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
    if (args[1]?.endsWith('policy_admin.py')) {
      if (args[2] === 'show') {
        return args[3] === 'c'.repeat(32)
          ? ok({
              id: args[3],
              digest: 'd'.repeat(64),
              state: 'PENDING',
              principal: 'notion',
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
    hostRun,
    setupSteps: SETUP_STEPS,
    layout,
    guest: new Guest(transport),
    lima: new LimaTransport(),
    log: () => {},
    quiet: true,
    idleMs,
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
      }),
    ]);
    const notices = (await client.call('tasks.events', { taskId: task.id }))
      .filter((e) => e.event.type === 'notice')
      .map((e) => (e.event as { text: string }).text);
    expect(notices).toContain(
      '⏸ waiting for your approval: POST /o/r.git/git-receive-pack (github)',
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
    const arg = transport.starts.at(-1)!.at(-1)!;
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
