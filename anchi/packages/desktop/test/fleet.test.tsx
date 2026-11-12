import type { AgentSummary, TaskRow } from '@anchi/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, TeamList } from '../src/renderer/App.tsx';
import { machineCall } from '../src/renderer/api.ts';
import { EMPTY_MODEL, reduceFleet, type Fleet } from '../src/renderer/model.ts';

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
    expect(out).toContain('TEAM · 2');
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
  expect(out).toContain('TEAM · 3');
  expect(out.match(/aria-label="@dev on dora"/g)).toHaveLength(1);
  expect(out.match(/aria-label="@dev on newuser"/g)).toHaveLength(1);
});

describe('one sidebar', () => {
  const local = { name: 'local', label: 'local', status: 'connected' as const };
  const remote = { name: 'instabox:newuser', label: 'newuser', status: 'error' as const };
  const sidebar = (connections: (typeof local | typeof remote)[], approvals = 0) =>
    renderToStaticMarkup(
      <Sidebar
        fleet={Object.fromEntries(
          connections.map((c) => [c.name, { ...EMPTY_MODEL, agents: [agent] }]),
        )}
        connections={connections}
        selected="local"
        view={{ kind: 'usage' }}
        approvals={approvals}
        setView={() => {}}
        onSelect={() => {}}
        onBuilder={() => {}}
      />,
    );

  it('lists the agents of a single machine without a machine heading', () => {
    const out = sidebar([local]);
    expect(out).toContain('TEAM · 1');
    expect(out).toContain('aria-label="@dev on local"');
    expect(out).not.toContain('team-host');
    expect(out).not.toContain('Agents on local');
    expect(out).toContain('This computer · connected');
    expect(out).toContain('aria-label="local is connected. Open settings"');
  });

  it('groups agents by machine and counts connections once there are several', () => {
    const out = sidebar([local, remote], 2);
    expect(out.match(/class="team-host"/g)).toHaveLength(2);
    expect(out).toContain('Agents on newuser');
    expect(out).toContain('1/2 machines connected');
    expect(out).not.toContain('This computer ·');
    expect(out).toContain('aria-label="Approvals, 2 waiting"');
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
    expect(out).toContain('This computer · error');
    expect(out).toContain('Offline · last known state');
  });
});
