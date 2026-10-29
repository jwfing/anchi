import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { homeLayout } from '@anchi/core';
import { z } from 'zod';
import { peerBudgetSchema, peerDispatchSchema } from '@anchi/protocol';
import type { TaskRow } from '@anchi/protocol';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/rpc.ts';
import { Guest, LimaTransport, type GuestTransport } from '../src/guest.ts';
import { HostLogins } from '../src/host-logins.ts';

const runner = join(import.meta.dirname, 'fixtures/fake-runner.mjs');
class Cells implements GuestTransport {
  toolDelay = 0;
  starts: string[][] = [];
  decisions: string[][] = [];
  policy = {
    state: 'PENDING',
    principal: 'x:coder',
    digest: 'f'.repeat(64),
    created: Date.now() / 1000,
    expires: Date.now() / 1000 + 600,
    action: {
      operation: 'publish',
      params: { text: 'review all of this: ' + 'x'.repeat(5000) + ' END' },
    },
  };
  spawn(args: string[]) {
    this.starts.push(args);
    return spawn(process.execPath, [runner], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_TOOL_DELAY_MS: String(this.toolDelay) },
    });
  }
  async exec(args: string[]) {
    if (args[1]?.endsWith('policy_admin.py')) {
      if (args[2] !== 'show') this.decisions.push(args);
      return { code: 0, stdout: JSON.stringify(args[2] === 'show' ? this.policy : {}), stderr: '' };
    }
    const result =
      args[0] === 'anchi-image'
        ? { present: true }
        : args[1] === 'scan'
          ? { clean: true, findings: [], files: 0 }
          : args[1] === 'audit'
            ? { rows: [] }
            : { reaped: [] };
    return { code: 0, stdout: JSON.stringify(result), stderr: '' };
  }
}

const daemons = new Set<Daemon>();
const clients: DaemonClient[] = [];
function home(agents: Record<string, string>) {
  const path = mkdtempSync(join(tmpdir(), 'anchi-team-'));
  const layout = homeLayout(path);
  mkdirSync(layout.agentsDir, { recursive: true });
  for (const [id, yaml] of Object.entries(agents)) {
    writeFileSync(join(layout.agentsDir, `${id}.yaml`), `runtime: codex\n${yaml}\n`);
  }
  return layout;
}
async function start(
  layout: ReturnType<typeof home>,
  cells: Cells,
  extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {},
) {
  const daemon = new Daemon({
    layout,
    guest: new Guest(cells),
    vm: new LimaTransport('anchi-vm-test', join(layout.root, 'no-limactl')),
    hostLogins: new HostLogins({
      codexFile: join(layout.root, 'no-auth'),
      claudeDir: layout.root,
      path: layout.root,
      platform: 'linux',
    }),
    approvals: false,
    triggers: false,
    hostLoginSync: false,
    quiet: true,
    log: () => {},
    workspaceRoot: join(layout.root, 'workspaces'),
    teamPollMs: 10,
    peerPollMs: 10,
    ...extra,
  });
  await daemon.start();
  daemons.add(daemon);
  const client = await DaemonClient.connect(layout.socketFile);
  clients.push(client);
  return { daemon, client };
}
async function finished(daemon: Daemon, id: string): Promise<TaskRow> {
  await expect
    .poll(() => daemon.hub.getTask(id).status, { timeout: 5000, interval: 10 })
    .not.toMatch(/running|queued/);
  return daemon.hub.getTask(id);
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  const stopping = [...daemons];
  daemons.clear();
  await Promise.all(stopping.map((daemon) => daemon.stop()));
});

async function peerTeam() {
  const leadHome = home({ lead: '' });
  const workHome = home({ coder: '' });
  const qaHome = home({ reviewer: '' });
  const leadCells = new Cells();
  const workCells = new Cells();
  const qaCells = new Cells();
  const a = await start(leadHome, leadCells);
  const b = await start(workHome, workCells);
  const c = await start(qaHome, qaCells);
  for (const [node, label] of [
    [a, 'local'],
    [b, 'newuser'],
    [c, 'dora'],
  ] as const)
    await node.client.call('peers.configure', {
      label,
      listen: '127.0.0.1',
      port: 0,
      address: 'tls://127.0.0.1:0',
    });
  const ai = await a.client.call('peers.identity');
  const bi = await b.client.call('peers.identity');
  const ci = await c.client.call('peers.identity');
  await a.client.call('peers.admit', { record: bi });
  await b.client.call('peers.admit', { record: ai });
  await a.client.call('peers.admit', { record: ci });
  await c.client.call('peers.admit', { record: ai });
  await expect
    .poll(async () => (await b.client.call('peers.directory')).nodes.filter((n) => n.online).length)
    .toBe(3);
  const ref = (r: typeof ai, id: string) => {
    const agent = r.agents.find((a) => a.id === id)!;
    return `${r.node}/${id}/${agent.generation}`;
  };
  const coder = ref(bi, 'coder');
  const reviewer = ref(ci, 'reviewer');
  return {
    a,
    b,
    c,
    ai,
    bi,
    ci,
    coder,
    reviewer,
    leadHome,
    workHome,
    qaHome,
    leadCells,
    workCells,
    qaCells,
  };
}

it('refuses an ungranted peer agent and forged origin without starting a cell', async () => {
  const t = await peerTeam();
  writeFileSync(
    join(t.leadHome.agentsDir, 'lead.yaml'),
    `runtime: codex\ndelegates: [${t.reviewer}]\n`,
  );
  await t.a.client.call('agents.reload');
  const task = await t.a.client.call('tasks.create', {
    agentId: 'lead',
    text: `call anchi_delegate_task ${JSON.stringify({ agent: t.coder, task: 'forbidden' })}`,
  });
  expect((await finished(t.a.daemon, task.id)).result).toContain('may not delegate');
  expect(t.workCells.starts).toHaveLength(0);
  await expect(
    t.a.daemon.peers.request(t.bi.node, 'task.run', {
      request: 't-0123456789',
      parent: { node: t.ci.node, task: 't-1234567890' },
      root: { node: t.ai.node, task: 't-1234567890' },
      target: t.coder,
      lineage: [`${t.ai.node}/lead/${t.ai.agents[0]!.generation}`, t.coder],
      budget: { start: 1, end: 10 },
      turn: 1,
      text: 'forged',
    }),
  ).rejects.toThrow('PEER_ORIGIN_DENIED');
  expect(t.workCells.starts).toHaveLength(0);
});

it('executes and mirrors local → peer → another peer without a coordinator wrapper', async () => {
  const t = await peerTeam();
  writeFileSync(
    join(t.leadHome.agentsDir, 'lead.yaml'),
    `runtime: codex\ndelegates: [${t.coder}]\n`,
  );
  writeFileSync(
    join(t.workHome.agentsDir, 'coder.yaml'),
    `runtime: codex\ndelegates: [${t.reviewer}]\n`,
  );
  await t.a.client.call('agents.reload');
  await t.b.client.call('agents.reload');
  const text = `call anchi_delegate_task ${JSON.stringify({ agent: t.reviewer, task: 'review across peers' })}`;
  const root = await t.a.client.call('tasks.create', {
    agentId: 'lead',
    text: `call anchi_delegate_task ${JSON.stringify({ agent: t.coder, task: text })}`,
  });
  expect((await finished(t.a.daemon, root.id)).result).toContain('review across peers');
  expect(t.workCells.starts).toHaveLength(1);
  expect(t.qaCells.starts).toHaveLength(1);
  expect((await t.a.client.call('tasks.tree', { taskId: root.id })).length).toBe(3);
});

it('continues peer work with the seed daemon stopped, then resumes its outbox without duplicate cells', async () => {
  const t = await peerTeam();
  writeFileSync(
    join(t.workHome.agentsDir, 'coder.yaml'),
    `runtime: codex\ndelegates: [${t.reviewer}]\n`,
  );
  await t.b.client.call('agents.reload');
  t.workCells.toolDelay = 500;
  const root = await t.a.client.call('tasks.create', {
    agentId: t.coder,
    text: `call anchi_delegate_task ${JSON.stringify({ agent: t.reviewer, task: 'seed is offline' })}`,
  });
  await expect.poll(() => t.workCells.starts.length).toBe(1);
  await t.a.daemon.stop();
  daemons.delete(t.a.daemon);
  const imported = (await t.b.client.call('tasks.list', {}))[0]!;
  expect((await finished(t.b.daemon, imported.id)).result).toContain('seed is offline');
  expect(t.qaCells.starts).toHaveLength(1);
  const next = await start(t.leadHome, t.leadCells);
  expect((await finished(next.daemon, root.id)).result).toContain('seed is offline');
  expect(t.workCells.starts).toHaveLength(1);
  // A separate in-flight mirror survives origin restart and can still cancel the same cell.
  const waiting = await next.client.call('tasks.create', {
    agentId: t.coder,
    text: 'say waiting then hang',
  });
  await expect
    .poll(() => next.daemon.store.events(waiting.id).some((e) => e.event.type === 'message'))
    .toBe(true);
  await next.daemon.stop();
  daemons.delete(next.daemon);
  const resumed = await start(t.leadHome, t.leadCells);
  await resumed.client.call('tasks.cancel', { taskId: waiting.id });
  expect((await finished(resumed.daemon, waiting.id)).status).toBe('cancelled');
  expect(t.workCells.starts).toHaveLength(2);
});

it('deduplicates dispatch, refuses conflicting content and preserves cancel-before-dispatch', async () => {
  const t = await peerTeam();
  const request = {
    request: 't-1122334455',
    parent: null,
    root: { node: t.ai.node, task: 't-1122334455' },
    target: t.coder,
    lineage: [t.coder],
    budget: { start: 0, end: 60 },
    turn: 1,
    text: 'once',
  };
  await Promise.all([1, 2, 3].map(() => t.a.daemon.peers.request(t.bi.node, 'task.run', request)));
  await expect.poll(() => t.workCells.starts.length).toBe(1);
  await expect(
    t.a.daemon.peers.request(t.bi.node, 'task.run', { ...request, text: 'changed' }),
  ).rejects.toThrow('PEER_REQUEST_CONFLICT');
  const cancelled = {
    ...request,
    request: 't-9988776655',
    root: { node: t.ai.node, task: 't-9988776655' },
  };
  await t.a.daemon.peers.request(t.bi.node, 'task.cancel', { request: cancelled.request, turn: 1 });
  await t.a.daemon.peers.request(t.bi.node, 'task.run', cancelled);
  await t.a.daemon.peers.request(t.bi.node, 'task.run', cancelled);
  const snapshot = await t.a.daemon.peers.request(t.bi.node, 'task.poll', {
    request: cancelled.request,
    afterSeq: 0,
  });
  expect(snapshot).toMatchObject({ task: { status: 'cancelled' } });
  expect(t.workCells.starts).toHaveLength(1);
  await expect(
    t.c.daemon.peers.request(t.bi.node, 'task.poll', { request: request.request, afterSeq: 0 }),
  ).rejects.toThrow('PEER_UNKNOWN_EXECUTION');
});

it('keeps approvals scoped to the authenticated origin and exact delegated task', async () => {
  const t = await peerTeam();
  const task = await t.a.client.call('tasks.create', { agentId: t.coder, text: 'hang' });
  await expect.poll(() => t.workCells.starts.length).toBe(1);
  const remote = (await t.b.client.call('tasks.list', {}))[0]!;
  const id = 'c'.repeat(32);
  await t.b.daemon.approvals.addPolicy(new Guest(t.workCells), remote, 'x', id);
  await expect.poll(async () => (await t.a.client.call('approvals.list')).length).toBe(1);
  const approval = (await t.a.client.call('approvals.list'))[0]!;
  expect(approval.summary).toContain(' END');
  expect(approval.task).toBe(task.id);
  const other = await t.a.client.call('tasks.create', { agentId: t.coder, text: 'hang' });
  await expect.poll(() => t.workCells.starts.length).toBe(2);
  await expect(
    t.a.daemon.peers.request(t.bi.node, 'task.approve', { request: other.id, id, allow: true }),
  ).rejects.toThrow('PEER_APPROVAL_DENIED');
  await expect(
    t.c.daemon.peers.request(t.bi.node, 'task.approve', { request: task.id, id, allow: true }),
  ).rejects.toThrow('PEER_UNKNOWN_EXECUTION');
  expect(t.workCells.decisions).toEqual([]);
  await t.a.client.call('approvals.decide', { id: approval.id, allow: false });
  expect(t.workCells.decisions[0]?.slice(2)).toEqual(['deny', id]);
  await t.a.client.call('tasks.cancel', { taskId: task.id });
  await t.a.client.call('tasks.cancel', { taskId: other.id });
  await finished(t.a.daemon, task.id);
  await finished(t.a.daemon, other.id);
});

it('rejects stale agent generations, cyclic lineage and exhausted turn budgets', async () => {
  const t = await peerTeam();
  const base = {
    request: 't-1234567890',
    parent: null,
    root: { node: t.ai.node, task: 't-1234567890' },
    target: t.coder,
    lineage: [t.coder],
    budget: { start: 0, end: 1 },
    turn: 1,
    text: 'one turn',
  };
  const stale = t.coder.slice(0, -16) + '0'.repeat(16);
  await expect(
    t.a.daemon.peers.request(t.bi.node, 'task.run', { ...base, target: stale, lineage: [stale] }),
  ).rejects.toThrow('PEER_AGENT_GENERATION_CHANGED');
  await expect(
    t.a.daemon.peers.request(t.bi.node, 'task.run', { ...base, budget: { start: 1, end: 1 } }),
  ).rejects.toThrow('PEER_TURN_BUDGET_EXHAUSTED');
  await expect(
    t.a.daemon.peers.request(t.bi.node, 'task.run', { ...base, lineage: [t.coder, t.coder] }),
  ).rejects.toThrow('PEER_ORIGIN_DENIED');
  expect(t.workCells.starts).toHaveLength(0);
  await t.a.daemon.peers.request(t.bi.node, 'task.run', base);
  const task = (await t.b.client.call('tasks.list', {}))[0]!;
  await finished(t.b.daemon, task.id);
  await t.a.daemon.peers.request(t.bi.node, 'task.run', { ...base, turn: 2 });
  expect((await finished(t.b.daemon, task.id)).result).toBe('PEER_TURN_BUDGET_EXHAUSTED');
  expect(t.workCells.starts).toHaveLength(1);
});

it('fails an interrupted executor turn after restart without replaying it', async () => {
  const t = await peerTeam();
  const task = await t.a.client.call('tasks.create', { agentId: t.coder, text: 'hang' });
  await expect.poll(() => t.workCells.starts.length).toBe(1);
  await t.b.daemon.stop();
  daemons.delete(t.b.daemon);
  const restarted = await start(t.workHome, t.workCells);
  expect((await finished(t.a.daemon, task.id)).status).toBe('failed');
  expect(t.workCells.starts).toHaveLength(1);
  const imported = (await restarted.client.call('tasks.list', {}))[0]!;
  await expect(
    restarted.client.call('tasks.send', { taskId: imported.id, text: 'bypass origin' }),
  ).rejects.toThrow('originating task');
});

it('retains cancellation while the executor is disconnected and applies it on reconnection', async () => {
  const t = await peerTeam();
  const task = await t.a.client.call('tasks.create', { agentId: t.coder, text: 'hang' });
  await expect.poll(() => t.workCells.starts.length).toBe(1);
  await t.b.daemon.peers.stop();
  await t.a.client.call('tasks.cancel', { taskId: task.id });
  const imported = (await t.b.client.call('tasks.list', {}))[0]!;
  expect(t.b.daemon.hub.getTask(imported.id).status).toBe('running');
  expect(t.a.daemon.hub.getTask(task.id).status).toMatch(/queued|running/);
  await t.b.daemon.peers.start();
  expect((await finished(t.a.daemon, task.id)).status).toBe('cancelled');
  expect(t.workCells.starts).toHaveLength(1);
});

it('partitions turn credits between local and peer children and refuses a cross-node cycle', async () => {
  const t = await peerTeam();
  const lead = `${t.ai.node}/lead/${t.ai.agents[0]!.generation}`;
  writeFileSync(join(t.leadHome.agentsDir, 'helper.yaml'), 'runtime: codex\n');
  writeFileSync(
    join(t.leadHome.agentsDir, 'lead.yaml'),
    `runtime: codex\ndelegates: [helper, ${t.coder}]\n`,
  );
  writeFileSync(join(t.workHome.agentsDir, 'coder.yaml'), `runtime: codex\ndelegates: [${lead}]\n`);
  await t.a.client.call('agents.reload');
  await t.b.client.call('agents.reload');
  const root = await t.a.client.call('tasks.create', {
    agentId: 'lead',
    text: `call anchi_delegate_task ${JSON.stringify({ agent: 'helper', task: 'local child' })}`,
  });
  await finished(t.a.daemon, root.id);
  await t.a.client.call('tasks.send', {
    taskId: root.id,
    text: `call anchi_delegate_task ${JSON.stringify({ agent: t.coder, task: `call anchi_delegate_task ${JSON.stringify({ agent: lead, task: 'cycle' })}` })}`,
  });
  expect((await finished(t.a.daemon, root.id)).result).toContain('PEER_DELEGATION_CYCLE');
  const tree = await t.a.client.call('tasks.tree', { taskId: root.id });
  const local = tree.find((row) => row.agentId === 'helper')!;
  const remote = (await t.b.client.call('tasks.list', {}))[0]!;
  const ranges = [
    t.a.daemon.store.teamGet(`peer/budget/${root.id}`, peerBudgetSchema)!,
    t.a.daemon.store.teamGet(`peer/budget/${local.id}`, peerBudgetSchema)!,
    t.b.daemon.store.teamGet(`peer/budget/${remote.id}`, peerBudgetSchema)!,
  ];
  for (let i = 0; i < ranges.length; i++)
    for (let j = i + 1; j < ranges.length; j++)
      expect(ranges[i]!.end <= ranges[j]!.start || ranges[j]!.end <= ranges[i]!.start).toBe(true);
  expect(t.leadCells.starts).toHaveLength(2); // lead and helper; never another lead cell
});

it('drains transcript pages before completion without exporting runtime session ids', async () => {
  const t = await peerTeam();
  await t.a.daemon.peerTasks.stop();
  const text = `usage ${JSON.stringify(Array.from({ length: 150 }, () => ({ inputTokens: 1, outputTokens: 1 })))}`;
  const task = await t.a.client.call('tasks.create', { agentId: t.coder, text });
  const out = t.a.daemon.store.teamGet(
    `peer/out/${task.id}`,
    z.object({ dispatch: peerDispatchSchema }),
  )!;
  await t.a.daemon.peers.request(t.bi.node, 'task.run', out.dispatch);
  const imported = (await t.b.client.call('tasks.list', {}))[0]!;
  await finished(t.b.daemon, imported.id);
  t.a.daemon.peerTasks.start();
  await finished(t.a.daemon, task.id);
  const events = t.a.daemon.store.events(task.id, 0, 500);
  expect(events.filter((e) => e.event.type === 'usage')).toHaveLength(150);
  expect(events.some((e) => e.event.type === 'turn.completed')).toBe(true);
  expect(events.some((e) => e.event.type === 'session.started')).toBe(false);
  expect(t.a.daemon.hub.getTask(task.id).resumeId).toBeNull();
});

it('resolves the CLI join target relative to the selected Anchi home', async () => {
  const t = await peerTeam();
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        join(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs'),
        join(import.meta.dirname, '../../tui/src/main.ts'),
        'team',
        'join',
        'local',
        '--yes',
      ],
      {
        env: { ...process.env, ANCHI_HOME: t.leadHome.root, ANCHI_SERVER: 'local' },
        timeout: 5000,
      },
    ),
  ).rejects.toThrow('Choose a different machine');
});
