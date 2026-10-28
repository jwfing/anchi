import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { homeLayout } from '@anchi/core';
import type { TaskRow, TeamRun } from '@anchi/protocol';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/rpc.ts';
import { Guest, LimaTransport, type GuestTransport } from '../src/guest.ts';
import { addServer } from '../src/remote.ts';
import { HostLogins } from '../src/host-logins.ts';

const runner = join(import.meta.dirname, 'fixtures/fake-runner.mjs');
class Cells implements GuestTransport {
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
    return spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  for (const daemon of daemons) await daemon.stop();
  daemons.clear();
});

async function team() {
  const workerLayout = home({ coder: 'delegates: [reviewer]' });
  const workerCells = new Cells();
  const worker = await start(workerLayout, workerCells);
  const layout = home({
    lead: 'delegates: [developer]',
    developer: 'execution: {server: cloud, agent: coder}\ndelegates: [reviewer]',
    reviewer: '',
  });
  addServer(layout.root, 'cloud', 'ssh:worker');
  const localCells = new Cells();
  const connect = () => DaemonClient.connect(workerLayout.socketFile);
  const coordinator = await start(layout, localCells, { teamConnect: connect });
  return { worker, workerCells, workerLayout, layout, localCells, connect, ...coordinator };
}

describe('one team across daemon sockets', () => {
  it('does not execute work rolled back before its dispatch receipt commits', async () => {
    const t = await team();
    expect(() =>
      t.daemon.store.transaction(() => {
        t.daemon.hub.createTask('developer', 'must not execute');
        throw new Error('transaction failed');
      }),
    ).toThrow('transaction failed');
    await sleep(30);
    expect(t.workerCells.starts).toHaveLength(0);
    expect(t.daemon.store.listTasks()).toHaveLength(0);
  });

  it('coordinates two remote nodes and replays a lost tool reply without duplicating a child', async () => {
    const t = await team();
    const qaLayout = home({ checker: '' });
    const qaCells = new Cells();
    const qa = await start(qaLayout, qaCells);
    addServer(t.layout.root, 'qa', 'ssh:qa');
    writeFileSync(
      join(t.layout.agentsDir, 'reviewer.yaml'),
      'runtime: codex\nexecution: {server: qa, agent: checker}\n',
    );
    await t.daemon.stop();
    daemons.delete(t.daemon);
    let lost = false;
    const next = await start(t.layout, t.localCells, {
      teamConnect: async (target) => {
        const socket = createConnection(
          target === 'ssh:qa' ? qaLayout.socketFile : t.workerLayout.socketFile,
        );
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        return DaemonClient.over(socket, async (method) => {
          if (method === 'team.reply' && !lost) {
            lost = true;
            socket.destroy();
            throw new Error('lost reply acknowledgement');
          }
        });
      },
    });
    const task = await next.client.call('tasks.create', {
      agentId: 'developer',
      text: 'call anchi_delegate_task {"agent":"reviewer","task":"verify remote collaboration"}',
    });
    expect((await finished(next.daemon, task.id)).result).toContain('verify remote collaboration');
    expect(next.daemon.store.children(task.id)).toHaveLength(1);
    expect(await qa.client.call('tasks.list', {})).toHaveLength(1);
    expect(t.workerCells.starts).toHaveLength(1);
    expect(qaCells.starts).toHaveLength(1);
    expect(t.localCells.starts).toHaveLength(0);
    expect(lost).toBe(true);
  });

  it('persists cancellation while disconnected and sends it before dispatch after restart', async () => {
    const t = await team();
    await t.daemon.stop();
    daemons.delete(t.daemon);
    const offline = await start(t.layout, t.localCells, {
      teamConnect: async () => {
        throw new Error('offline');
      },
    });
    const task = await offline.client.call('tasks.create', {
      agentId: 'developer',
      text: 'never start',
    });
    await expect
      .poll(() => offline.daemon.store.events(task.id).some((e) => e.event.type === 'notice'))
      .toBe(true);
    await offline.client.call('tasks.cancel', { taskId: task.id });
    await offline.daemon.stop();
    daemons.delete(offline.daemon);
    const online = await start(t.layout, t.localCells, { teamConnect: t.connect });
    expect((await finished(online.daemon, task.id)).status).toBe('cancelled');
    expect(t.workerCells.starts).toHaveLength(0);
  });

  it('reviews and creates a remote member without copying credentials or access settings', async () => {
    const t = await team();
    const proposal = await t.client.call('team.preview', {
      agentId: 'new-member',
      execution: { server: 'cloud', agent: 'coder' },
    });
    expect(proposal.errors).toEqual([]);
    expect(proposal.agentYaml).toContain('execution:');
    expect(proposal.agentYaml).not.toContain('connectors:');
    await t.client.call('builder.apply', { proposalId: proposal.id });
    expect(
      (await t.client.call('agents.settings', { agentId: 'new-member' })).fixed.execution,
    ).toEqual({ server: 'cloud', agent: 'coder' });
    const patch = await t.client.call('agents.update', {
      agentId: 'new-member',
      patch: { connectors: ['github'] },
    });
    expect(patch.errors.join(' ')).toContain('execution node');
    await expect(
      t.client.call('team.preview', {
        agentId: 'new-member',
        execution: { server: 'cloud', agent: 'coder' },
      }),
    ).rejects.toThrow('already exists');
  });

  it('delegates local → remote → local with one task tree and scoped identities', async () => {
    const t = await team();
    const review =
      'call anchi_delegate_task ' + JSON.stringify({ agent: 'reviewer', task: 'review the patch' });
    const task = await t.client.call('tasks.create', {
      agentId: 'lead',
      text: 'call anchi_delegate_task ' + JSON.stringify({ agent: 'developer', task: review }),
    });
    const result = await finished(t.daemon, task.id);
    expect(result.status).toBe('done');
    const child = t.daemon.store.children(task.id)[0]!;
    const grandchild = t.daemon.store.children(child.id)[0]!;
    expect(child).toMatchObject({
      agentId: 'developer',
      status: 'done',
      rootId: task.id,
      depth: 1,
      execution: { server: 'cloud', agent: 'coder' },
    });
    expect(grandchild).toMatchObject({
      agentId: 'reviewer',
      status: 'done',
      rootId: task.id,
      depth: 2,
    });
    expect(result.result).toContain('review the patch');
    expect(t.workerCells.starts).toHaveLength(1);
    expect(t.localCells.starts).toHaveLength(2);
    const who = await t.client.call('tasks.create', {
      agentId: 'developer',
      text: 'call anchi_whoami {}',
    });
    expect((await finished(t.daemon, who.id)).result).toContain(who.id);
  });

  it('deduplicates lost dispatch acknowledgements, follow-ups and usage', async () => {
    const t = await team();
    await t.daemon.stop();
    daemons.delete(t.daemon);
    let lost = false;
    const restarted = await start(t.layout, t.localCells, {
      teamConnect: async () => {
        const socket = createConnection(t.workerLayout.socketFile);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        return DaemonClient.over(socket, async (method) => {
          if (method === 'team.run' && !lost) {
            lost = true;
            socket.destroy();
            throw new Error('lost acknowledgement');
          }
        });
      },
    });
    const task = await restarted.client.call('tasks.create', {
      agentId: 'developer',
      text: 'usage [{"inputTokens":11,"outputTokens":7}]',
    });
    expect(await finished(restarted.daemon, task.id)).toMatchObject({
      status: 'done',
      turns: 1,
      inputTokens: 11,
      outputTokens: 7,
    });
    await restarted.client.call('tasks.send', { taskId: task.id, text: 'next' });
    expect(await finished(restarted.daemon, task.id)).toMatchObject({ status: 'done', turns: 2 });
    expect(t.workerCells.starts).toHaveLength(1);
    expect(await t.worker.client.call('tasks.list', {})).toHaveLength(1);
    const imported = (await t.worker.client.call('tasks.list', {}))[0]!;
    await expect(
      t.worker.client.call('tasks.send', { taskId: imported.id, text: 'bypass coordinator' }),
    ).rejects.toThrow('coordinator');
  });

  it('reattaches after coordinator restart and propagates cancellation', async () => {
    const t = await team();
    const task = await t.client.call('tasks.create', {
      agentId: 'developer',
      text: 'say waiting then hang',
    });
    await expect
      .poll(() => t.daemon.store.events(task.id).some((e) => e.event.type === 'message'), {
        timeout: 5000,
      })
      .toBe(true);
    await t.daemon.stop();
    daemons.delete(t.daemon);
    const next = await start(t.layout, t.localCells, { teamConnect: t.connect });
    await expect.poll(() => next.daemon.hub.getTask(task.id).status).toBe('running');
    await next.client.call('tasks.cancel', { taskId: task.id });
    expect(await finished(next.daemon, task.id)).toMatchObject({ status: 'cancelled', turns: 1 });
    expect(t.workerCells.starts).toHaveLength(1);
    expect((await t.worker.client.call('tasks.list', {}))[0]?.status).toBe('cancelled');
  });

  it('records cancellation before dispatch so reconnect cannot start cancelled work', async () => {
    const t = await team();
    const request: TeamRun = {
      origin: {
        coordinator: 'b'.repeat(32),
        task: 't-0123456789',
        agent: 'developer',
        chain: ['you'],
      },
      agent: 'coder',
      text: 'must never execute',
      turn: 1,
    };
    await t.worker.client.call('team.cancel', {
      coordinator: request.origin.coordinator,
      task: request.origin.task,
      turn: 1,
    });
    await t.worker.client.call('team.run', request);
    await t.worker.client.call('team.run', request);
    await sleep(30);
    expect(t.workerCells.starts).toHaveLength(0);
    expect(
      (
        await t.worker.client.call('team.poll', {
          coordinator: request.origin.coordinator,
          task: request.origin.task,
          afterSeq: 0,
        })
      ).task.status,
    ).toBe('cancelled');
    await expect(t.worker.client.call('team.run', { ...request, text: 'changed' })).rejects.toThrow(
      'TEAM_REQUEST_CONFLICT',
    );
  });

  it('routes complete approvals to the right node and refuses decisions for another task', async () => {
    const t = await team();
    const task = await t.client.call('tasks.create', { agentId: 'developer', text: 'hang' });
    await expect.poll(() => t.workerCells.starts.length).toBe(1);
    const remote = (await t.worker.client.call('tasks.list', {}))[0]!;
    const id = 'c'.repeat(32);
    await t.worker.daemon.approvals.addPolicy(new Guest(t.workerCells), remote, 'x', id);
    await expect.poll(async () => (await t.client.call('approvals.list')).length).toBe(1);
    const approval = (await t.client.call('approvals.list'))[0]!;
    expect(approval).toMatchObject({ task: task.id, agent: 'developer', kind: 'policy' });
    expect(approval.summary).toContain(' END');
    expect(approval.origin).toContain('cloud/coder');
    expect(approval.id).not.toBe(id);
    const other = await t.client.call('tasks.create', { agentId: 'developer', text: 'hang' });
    await expect.poll(() => t.workerCells.starts.length).toBe(2);
    await expect(
      t.worker.client.call('team.approve', {
        coordinator: t.daemon.store.nodeId(),
        task: other.id,
        id,
        allow: true,
      }),
    ).rejects.toThrow('TEAM_APPROVAL_DENIED');
    expect(t.workerCells.decisions).toEqual([]);
    await t.client.call('approvals.decide', { id: approval.id, allow: false });
    expect(t.workerCells.decisions).toHaveLength(1);
    expect(t.workerCells.decisions[0]?.slice(2)).toEqual(['deny', id]);
    await t.client.call('tasks.cancel', { taskId: task.id });
    await t.client.call('tasks.cancel', { taskId: other.id });
    await finished(t.daemon, task.id);
    await finished(t.daemon, other.id);
  });

  it('enforces coordinator grants, child ownership and cycles across nodes', async () => {
    const t = await team();
    writeFileSync(
      join(t.workerLayout.agentsDir, 'coder.yaml'),
      'runtime: codex\ndelegates: [reviewer, lead]\n',
    );
    t.worker.daemon.hub.reload();
    const denied = await t.client.call('tasks.create', {
      agentId: 'developer',
      text: 'call anchi_delegate_task {"agent":"lead","task":"forbidden"}',
    });
    expect((await finished(t.daemon, denied.id)).result).toContain('TEAM_DELEGATE_DENIED');
    expect(t.daemon.store.children(denied.id)).toHaveLength(0);
    const unrelated = await t.client.call('tasks.create', {
      agentId: 'reviewer',
      text: 'private task',
    });
    await finished(t.daemon, unrelated.id);
    const snoop = await t.client.call('tasks.create', {
      agentId: 'developer',
      text: `call anchi_task_status ${JSON.stringify({ task: unrelated.id })}`,
    });
    expect((await finished(t.daemon, snoop.id)).result).toContain('was not delegated by this task');
    writeFileSync(
      join(t.layout.agentsDir, 'developer.yaml'),
      'runtime: codex\nexecution: {server: cloud, agent: coder}\ndelegates: [lead]\n',
    );
    t.daemon.hub.reload();
    const cycle = await t.client.call('tasks.create', {
      agentId: 'lead',
      text:
        'call anchi_delegate_task ' +
        JSON.stringify({
          agent: 'developer',
          task: 'call anchi_delegate_task {"agent":"lead","task":"cycle"}',
        }),
    });
    const result = await finished(t.daemon, cycle.id);
    expect(result.result).toContain('already working on a task above');
    const child = t.daemon.store.children(cycle.id)[0]!;
    expect(t.daemon.store.children(child.id)).toHaveLength(0);
  });

  it('fails an interrupted worker without replaying its turn and keeps the node pinned', async () => {
    const t = await team();
    const task = await t.client.call('tasks.create', { agentId: 'developer', text: 'hang' });
    await expect.poll(() => t.workerCells.starts.length).toBe(1);
    await t.worker.daemon.stop();
    daemons.delete(t.worker.daemon);
    await start(t.workerLayout, t.workerCells);
    expect((await finished(t.daemon, task.id)).status).toBe('failed');
    expect(t.workerCells.starts).toHaveLength(1);
    writeFileSync(
      join(t.layout.agentsDir, 'developer.yaml'),
      'runtime: codex\nexecution: {server: missing, agent: absent}\n',
    );
    t.daemon.hub.reload();
    await t.client.call('tasks.send', { taskId: task.id, text: 'continue original worker' });
    expect((await finished(t.daemon, task.id)).status).toBe('done');
    expect(t.workerCells.starts).toHaveLength(2);
  });

  it('refuses to re-dispatch to a replacement node identity', async () => {
    const t = await team();
    const task = await t.client.call('tasks.create', { agentId: 'developer', text: 'hang' });
    await expect.poll(() => t.workerCells.starts.length).toBe(1);
    await t.daemon.stop();
    daemons.delete(t.daemon);
    t.worker.daemon.store.teamPut('node', 'e'.repeat(32));
    const next = await start(t.layout, t.localCells, { teamConnect: t.connect });
    expect(await finished(next.daemon, task.id)).toMatchObject({
      status: 'failed',
      result: 'TEAM_NODE_CHANGED',
    });
    expect(t.workerCells.starts).toHaveLength(1);
  });

  it('keeps the runtime pinned when reconnecting within the first dispatched turn', async () => {
    const t = await team();
    await t.daemon.stop();
    daemons.delete(t.daemon);
    let changed = false;
    const next = await start(t.layout, t.localCells, {
      teamConnect: async () => {
        const socket = createConnection(t.workerLayout.socketFile);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        return DaemonClient.over(socket, async (method) => {
          if (method === 'team.run' && !changed) {
            changed = true;
            writeFileSync(join(t.workerLayout.agentsDir, 'coder.yaml'), 'runtime: claude-code\n');
            t.worker.daemon.hub.reload();
            socket.destroy();
            throw new Error('connection lost after dispatch');
          }
        });
      },
    });
    const task = await next.client.call('tasks.create', { agentId: 'developer', text: 'hang' });
    expect(await finished(next.daemon, task.id)).toMatchObject({
      status: 'failed',
      runtime: 'codex',
      result: 'TEAM_RUNTIME_CHANGED',
    });
  });

  it('refuses node loops, missing workers, administration and another task’s approval', async () => {
    const t = await team();
    const request: TeamRun = {
      origin: {
        coordinator: t.worker.daemon.store.nodeId(),
        task: 't-0123456789',
        agent: 'developer',
        chain: ['you'],
      },
      agent: 'coder',
      text: 'no',
      turn: 1,
    };
    await expect(t.worker.client.call('team.run', request)).rejects.toThrow('TEAM_SELF_EXECUTION');
    await expect(t.worker.client.call('team.describe', { agent: 'builder' })).rejects.toThrow();
    await expect(
      t.client.call('team.preview', {
        agentId: 'other',
        execution: { server: 'cloud', agent: 'absent' },
      }),
    ).rejects.toThrow('TEAM_AGENT_UNAVAILABLE');
    const task = await t.client.call('tasks.create', {
      agentId: 'developer',
      text: 'call approvals.decide {"id":"other","allow":true}',
    });
    expect((await finished(t.daemon, task.id)).result).toContain('TEAM_TOOL_DENIED');
    await expect(
      t.worker.client.call('team.approve', {
        coordinator: t.daemon.store.nodeId(),
        task: task.id,
        id: 'other',
        allow: true,
      }),
    ).rejects.toThrow('TEAM_APPROVAL_DENIED');
    expect(t.daemon.store.children(task.id)).toHaveLength(0);
  });
});
