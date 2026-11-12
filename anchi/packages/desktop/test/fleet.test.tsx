import type { AgentSummary, TaskRow } from '@anchi/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, TeamList } from '../src/renderer/App.tsx';
import { machineCall } from '../src/renderer/api.ts';
import { EMPTY_MODEL, reduceFleet, type Fleet } from '../src/renderer/model.ts';
import { attention, attentionCount } from '../src/renderer/views/NeedsYou.tsx';

const agent: AgentSummary = {
  id: 'dev',
  name: 'Developer',
  connectors: [],
  status: 'idle',
  running: 0,
  queued: 0,
  maxTasks: 1,
  file: 'dev.yaml',
};
const task: TaskRow = {
  id: 'same',
  agentId: 'dev',
  trigger: 'user',
  title: 'local work',
  status: 'done',
  resumeId: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: 2,
  result: null,
  links: [],
  parentId: null,
  rootId: 'same',
  depth: 0,
  turns: 1,
  inputTokens: 1,
  outputTokens: 2,
};

describe('all-machine desktop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps matching agent and task ids separate, including transcripts and reloads', () => {
    let fleet: Fleet = {};
    for (const server of ['local', 'instabox:newuser']) {
      fleet = reduceFleet(fleet, {
        type: 'machine',
        server,
        action: { type: 'agents', agents: [agent] },
      });
      fleet = reduceFleet(fleet, {
        type: 'machine',
        server,
        action: { type: 'tasks', tasks: [{ ...task, title: server }] },
      });
      fleet = reduceFleet(fleet, {
        type: 'machine',
        server,
        action: {
          type: 'events',
          taskId: 'same',
          events: [{ seq: 1, ts: 1, event: { type: 'message', text: server } }],
        },
      });
    }
    fleet = reduceFleet(fleet, {
      type: 'machine',
      server: 'instabox:newuser',
      action: { type: 'tasks', tasks: [], replace: true },
    });
    expect(fleet.local?.tasks.same?.title).toBe('local');
    expect(fleet['instabox:newuser']?.tasks).toEqual({});
    expect(fleet.local?.events.same?.[0]?.event).toEqual({ type: 'message', text: 'local' });
    expect(fleet['instabox:newuser']?.events.same?.[0]?.event).toEqual({
      type: 'message',
      text: 'instabox:newuser',
    });
    expect(Object.keys(reduceFleet(fleet, { type: 'retain', servers: ['local'] }))).toEqual([
      'local',
    ]);
  });

  it('shows both same-name agents, their machines, and offline state together', () => {
    const out = renderToStaticMarkup(
      <TeamList
        fleet={{
          local: { ...EMPTY_MODEL, agents: [agent] },
          'instabox:newuser': { ...EMPTY_MODEL, agents: [agent] },
        }}
        connections={[
          { name: 'local', label: 'local', status: 'connected' },
          { name: 'instabox:newuser', label: 'newuser', status: 'error' },
        ]}
        selected="local"
        view={{ kind: 'agent', agentId: 'dev' }}
        onSelect={() => {}}
        onBuilder={() => {}}
      />,
    );
    expect(out).toContain('AGENTS · 2');
    expect(out).toContain('@dev on local');
    expect(out).toContain('@dev on newuser');
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
    expect(out).toContain('Offline · last known state');
  });

  it('binds all configuration and task calls to the machine that owns the view', async () => {
    const transport = vi.fn(async () => null);
    vi.stubGlobal('window', { anchi: { call: transport } });
    const local = machineCall('local');
    const remote = machineCall('instabox:newuser');
    await remote('setup.status');
    await remote('skills.list');
    await local('tasks.create', { agentId: 'dev', text: 'local work' });
    await remote('setup.importCodex');
    await remote('connectors.remove', { id: 'github' });
    await remote('services.setMode', { id: 'slack', mode: 'ask' });
    await remote('approvals.decide', { id: 'same', allow: false });
    expect(transport.mock.calls.map((args) => args.slice(0, 2))).toEqual([
      ['instabox:newuser', 'setup.status'],
      ['instabox:newuser', 'skills.list'],
      ['local', 'tasks.create'],
      ['instabox:newuser', 'setup.importCodex'],
      ['instabox:newuser', 'connectors.remove'],
      ['instabox:newuser', 'services.setMode'],
      ['instabox:newuser', 'approvals.decide'],
    ]);
  });
});

it('discovers a third machine through one connection and deduplicates directly connected peers', () => {
  const peer = (node: string, machine: string): AgentSummary => ({
    ...agent,
    id: `${node}/dev/${'c'.repeat(16)}`,
    peer: { node, agent: 'dev', machine, online: true },
  });
  const cloud = 'a'.repeat(32);
  const dora = 'b'.repeat(32);
  const out = renderToStaticMarkup(
    <TeamList
      fleet={{
        local: { ...EMPTY_MODEL, agents: [agent, peer(cloud, 'newuser'), peer(dora, 'dora')] },
        newuser: { ...EMPTY_MODEL, agents: [{ ...agent, node: cloud }, peer(dora, 'dora')] },
      }}
      connections={[
        { name: 'local', label: 'local', status: 'connected' },
        { name: 'newuser', label: 'newuser', status: 'connected' },
      ]}
      selected="local"
      view={{ kind: 'agent', agentId: peer(dora, 'dora').id }}
      onSelect={() => {}}
      onBuilder={() => {}}
    />,
  );
  expect(out).toContain('AGENTS · 3');
  expect(out.match(/aria-label="@dev on dora"/g)).toHaveLength(1);
  expect(out.match(/aria-label="@dev on newuser"/g)).toHaveLength(1);
});

describe('one sidebar', () => {
  const local = { name: 'local', label: 'local', status: 'connected' as const };
  const remote = { name: 'instabox:newuser', label: 'newuser', status: 'error' as const };
  const sidebar = (connections: (typeof local | typeof remote)[], waiting = 0) =>
    renderToStaticMarkup(
      <Sidebar
        fleet={Object.fromEntries(
          connections.map((c) => [c.name, { ...EMPTY_MODEL, agents: [agent] }]),
        )}
        connections={connections}
        selected="local"
        view={{ kind: 'usage' }}
        waiting={waiting}
        setView={() => {}}
        onSelect={() => {}}
        onBuilder={() => {}}
      />,
    );

  it('lists the agents of a single machine without a machine heading', () => {
    const out = sidebar([local]);
    expect(out).toContain('AGENTS · 1');
    expect(out).toContain('aria-label="@dev on local"');
    expect(out).not.toContain('team-host');
    expect(out).not.toContain('Agents on local');
    expect(out).toContain('>Protected<');
    expect(out).toContain('This computer · 1 agent sealed');
  });

  it('groups agents by machine and counts connections once there are several', () => {
    const out = sidebar([local, remote], 2);
    expect(out.match(/class="team-host"/g)).toHaveLength(2);
    expect(out).toContain('Agents on newuser');
    expect(out).toContain('1/2 machines · 1 agent sealed');
    expect(out).not.toContain('This computer ·');
    expect(out).toContain('aria-label="Needs you, 2 waiting"');
  });

  it('keeps a machine heading for a peer discovered through the only connection', () => {
    const node = 'd'.repeat(32);
    const out = renderToStaticMarkup(
      <TeamList
        fleet={{
          local: {
            ...EMPTY_MODEL,
            agents: [
              agent,
              {
                ...agent,
                id: `${node}/dev/${'c'.repeat(16)}`,
                peer: { node, agent: 'dev', machine: 'dora', online: false },
              },
            ],
          },
        }}
        connections={[local]}
        selected="local"
        view={{ kind: 'builder' }}
        onSelect={() => {}}
        onBuilder={() => {}}
      />,
    );
    expect(out.match(/class="team-host"/g)).toHaveLength(2);
    expect(out).toContain('Agents on dora');
  });

  it('marks the open view and shows the state of a machine that is not connected', () => {
    const out = sidebar([{ ...local, status: 'error' as const }]);
    expect(out).toContain('aria-label="Usage" aria-current="page"');
    expect(out).toContain('dot dot-error');
    expect(out).toContain('>Not connected<');
    expect(out).toContain('This computer · error');
    expect(out).toContain('Offline · last known state');
  });
});

describe('needs you', () => {
  const local = { name: 'local', label: 'local', status: 'connected' as const };
  const approval = (id: string, createdAt: number) =>
    ({ id, agent: 'dev', task: 't', createdAt, timeout: 600 }) as never;
  const locked = {
    vm: 'running',
    installed: true,
    vaultUnlocked: false,
    vaultKeyPresent: true,
  } as never;

  it('gathers held writes of every machine, oldest first, each with its machine', () => {
    const remote = { name: 'ssh:box', label: 'box', status: 'connected' as const };
    const found = attention(
      {
        local: { ...EMPTY_MODEL, approvals: [approval('same', 20)] },
        'ssh:box': { ...EMPTY_MODEL, approvals: [approval('same', 10)] },
      },
      [local, remote],
      null,
    );
    expect(found.approvals.map((a) => [a.server.name, a.approval.id])).toEqual([
      ['ssh:box', 'same'],
      ['local', 'same'],
    ]);
    expect(attentionCount(found)).toBe(2);
  });

  it('adds a locked vault, a machine that does not answer, and what can be upgraded', () => {
    const found = attention(
      { local: { ...EMPTY_MODEL, setup: locked } },
      [
        local,
        { name: 'ssh:down', label: 'down', status: 'error', error: 'no route' },
        { name: 'ssh:new', label: 'new', status: 'needs-setup' },
        { name: 'ssh:old', label: 'old', status: 'connected', newer: '9.9.9', install: 'release' },
        { name: 'ssh:src', label: 'src', status: 'connected', newer: '9.9.9', install: 'source' },
      ],
      { currentVersion: '1.0.0', version: '9.9.9', url: 'https://example.com' },
    );
    expect(found.notices.map((n) => [n.kind, n.kind === 'update' ? 'app' : n.server.name])).toEqual(
      [
        ['vault', 'local'],
        ['connection', 'ssh:down'],
        ['connection', 'ssh:new'],
        ['upgrade', 'ssh:old'],
        ['update', 'app'],
      ],
    );
  });

  it('asks for nothing about a machine the user disconnected or one still connecting', () => {
    const found = attention(
      { local: { ...EMPTY_MODEL, setup: locked, approvals: [] } },
      [
        { ...local, status: 'connecting' },
        { name: 'ssh:off', label: 'off', status: 'disconnected' },
      ],
      null,
    );
    expect(attentionCount(found)).toBe(0);
  });

  it('says the vault is locked in the sidebar, in place of protected', () => {
    const out = renderToStaticMarkup(
      <Sidebar
        fleet={{ local: { ...EMPTY_MODEL, agents: [agent], setup: locked } }}
        connections={[local]}
        selected="local"
        view={{ kind: 'inbox' }}
        waiting={1}
        setView={() => {}}
        onSelect={() => {}}
        onBuilder={() => {}}
      />,
    );
    expect(out).toContain('>Vault locked<');
    expect(out).not.toContain('>Protected<');
    expect(out).toContain('aria-label="Needs you, 1 waiting" aria-current="page"');
  });
});
