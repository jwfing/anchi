import type { AgentSummary, TaskRow } from '@anchi/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, TeamList } from '../src/renderer/App.tsx';
import { machineCall, message } from '../src/renderer/api.ts';
import { EMPTY_MODEL, reduceFleet, type Fleet } from '../src/renderer/model.ts';
import { attention, attentionCount } from '../src/renderer/views/NeedsYou.tsx';
import { startChecklist } from '../src/renderer/views/Starting.tsx';

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
    // A member that is off is offline, reported by the machine that knows it: not an error.
    expect(out).toContain('offline · through local');
    expect(out).not.toContain('dot-error');
    expect(out).not.toContain('>error<');
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

describe('starting', () => {
  const ready = { vm: 'running', installed: true, vaultUnlocked: true } as never;
  const states = (...args: Parameters<typeof startChecklist>) =>
    startChecklist(...args).map((c) => `${c.id}:${c.state}`);

  it('waits for everything below the part that is not up yet', () => {
    expect(states({ status: 'connecting' }, undefined, 0)).toEqual([
      'service:now',
      'room:wait',
      'vault:wait',
      'agents:wait',
    ]);
    expect(states({ status: 'connected' }, undefined, 2)).toEqual([
      'service:done',
      'room:now',
      'vault:wait',
      'agents:done',
    ]);
    expect(states({ status: 'connected' }, ready, 2)).toEqual([
      'service:done',
      'room:done',
      'vault:done',
      'agents:done',
    ]);
  });

  it('says which part failed: the service, a stopped secure room, or a locked vault', () => {
    expect(states({ status: 'error' }, ready, 2)[0]).toBe('service:fail');
    expect(startChecklist({ status: 'needs-setup' }, undefined, 0)[0]!.status).toBe(
      'Not installed',
    );
    const stopped = { vm: 'stopped', installed: true, vaultUnlocked: true } as never;
    expect(states({ status: 'connected' }, stopped, 1).slice(1, 3)).toEqual([
      'room:fail',
      'vault:wait',
    ]);
    expect(startChecklist({ status: 'connected' }, stopped, 1)[1]!.status).toBe('Stopped');
    const locked = { vm: 'running', installed: true, vaultUnlocked: false } as never;
    expect(states({ status: 'connected' }, locked, 1).slice(1, 3)).toEqual([
      'room:done',
      'vault:fail',
    ]);
  });
});

describe('secure room notices', () => {
  const local = { name: 'local', label: 'local', status: 'connected' as const };
  const kinds = (setup: object) =>
    attention({ local: { ...EMPTY_MODEL, setup: setup as never } }, [local], null).notices.map(
      (n) => (n.kind === 'room' ? `room:${n.outdated ? 'outdated' : 'stopped'}` : n.kind),
    );

  it('asks to start a stopped secure room or update an outdated one, before the vault', () => {
    expect(kinds({ vm: 'stopped', installed: true, vaultUnlocked: false })).toEqual([
      'room:stopped',
    ]);
    // A stopped VM cannot report what is installed in it.
    expect(kinds({ vm: 'stopped', installed: false, vaultUnlocked: false })).toEqual([
      'room:stopped',
    ]);
    expect(
      kinds({ vm: 'running', installed: true, guestOutdated: true, vaultUnlocked: false }),
    ).toEqual(['room:outdated']);
  });

  it('says in the sidebar that the secure room is stopped, not that agents are protected', () => {
    const out = renderToStaticMarkup(
      <Sidebar
        fleet={{
          local: {
            ...EMPTY_MODEL,
            agents: [agent],
            setup: { vm: 'stopped', installed: false, vaultUnlocked: false } as never,
          },
        }}
        connections={[local]}
        selected="local"
        view={{ kind: 'inbox' }}
        waiting={1}
        setView={() => {}}
        onSelect={() => {}}
        onBuilder={() => {}}
      />,
    );
    expect(out).toContain('>Secure room stopped<');
    expect(out).not.toContain('>Protected<');
  });

  it('leaves a machine that was never set up to the guide', () => {
    expect(kinds({ vm: 'missing', installed: false, vaultUnlocked: false })).toEqual([]);
  });
});

it('says the secure room is not running instead of passing on a command to run', () => {
  const raw =
    'Error invoking remote method \'anchi:call\': Error: GUEST_UNAVAILABLE: level=fatal msg="instance `anchi-vm` is stopped, run `limactl start anchi-vm`"';
  expect(message(new Error(raw))).toBe(
    'The secure room is not running, so this cannot be read or changed now. Start it from Needs you.',
  );
  expect(
    message(
      new Error("Error invoking remote method 'anchi:call': Error: PEER_NETWORK_NOT_CONFIGURED"),
    ),
  ).toContain('has no team address yet');
  expect(message(new Error("Error invoking remote method 'anchi:call': Error: cancelled"))).toBe(
    'cancelled',
  );
});
