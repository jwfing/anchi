import { describe, expect, it, vi } from 'vitest';
import { Connections, type Connection } from '../src/main/connections.ts';
import { LOCAL_UPGRADE, REMOTE_UPGRADE, ServerUpgrade } from '../src/main/upgrade.ts';
import type { ServerState } from '../src/shared.ts';

const DORA = 'instabox:anchi-dora';

function setup(over: { install?: string; version?: string; latest?: string | null } = {}) {
  let current = true;
  const daemon = { cells: 0, version: over.version ?? '0.4.3', install: over.install ?? 'release' };
  const tasks: Record<string, unknown[]> = { running: [], queued: [] };
  const setupStatus = {
    installed: true,
    guestOutdated: true,
    preparedRuntimes: ['claude-code'],
  };
  let state: ServerState = {
    name: DORA,
    label: 'dora',
    status: 'connected',
    version: daemon.version,
    install: 'release',
  };
  const read = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'daemon.status') return { ...daemon };
    if (method === 'tasks.search') return tasks[(params as { status: string }).status];
    if (method === 'setup.status') return setupStatus;
    if (method === 'setup.prepare') return setupStatus;
    throw new Error(`unexpected ${method}`);
  });
  const confirm = vi.fn(async () => true);
  const run = vi.fn(async () => {
    daemon.version = '0.4.4';
  });
  const reconnect = vi.fn(async () => {
    state = { ...state, version: daemon.version };
  });
  const flow = new ServerUpgrade({
    state: (target) => (target === state.name ? state : undefined),
    latest: () => (over.latest === undefined ? '0.4.4' : over.latest),
    lease: () => ({ read }),
    pin: () => () => {
      if (!current) throw new Error('machine connection changed; review the action again');
    },
    confirm,
    run,
    reconnect,
    wait: async (_target, ready) => {
      if (!ready(state)) throw new Error('the upgraded daemon did not come back');
      return state;
    },
    changed: () => {},
  });
  return {
    flow,
    read,
    confirm,
    run,
    daemon,
    tasks,
    setupStatus,
    invalidate: () => {
      current = false;
    },
  };
}

describe('machine upgrades', () => {
  it('offers the latest release only to a connected machine that is behind it', () => {
    const { flow } = setup();
    const base: ServerState = { name: DORA, label: 'dora', status: 'connected', version: '0.4.3' };
    expect(flow.newer(base)).toBe('0.4.4');
    expect(flow.newer({ ...base, version: '0.4.4' })).toBeUndefined();
    expect(flow.newer({ ...base, version: '0.5.0' })).toBeUndefined();
    expect(flow.newer({ ...base, status: 'error' })).toBeUndefined();
    expect(flow.newer({ ...base, version: undefined })).toBeUndefined();
    expect(setup({ latest: null }).flow.newer(base)).toBeUndefined();
  });

  it('refuses unknown machines without reading or running anything', async () => {
    const s = setup();
    for (const target of ['instabox:unknown', null, {}, 42]) {
      await expect(s.flow.upgrade(target)).rejects.toThrow(/unknown machine/);
    }
    expect(s.read).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });

  it('refuses a source checkout and a machine already on the latest release', async () => {
    const source = setup({ install: 'source' });
    await expect(source.flow.upgrade(DORA)).rejects.toThrow(/source checkout.*scripts\/remote\.sh/);
    const latest = setup({ version: '0.4.4' });
    await expect(latest.flow.upgrade(DORA)).rejects.toThrow(/already runs the latest/);
    for (const s of [source, latest]) {
      expect(s.confirm).not.toHaveBeenCalled();
      expect(s.run).not.toHaveBeenCalled();
    }
  });

  it('refuses while a cell runs or a task is running or queued', async () => {
    for (const busy of ['cells', 'running', 'queued'] as const) {
      const s = setup();
      if (busy === 'cells') s.daemon.cells = 1;
      else s.tasks[busy] = [{ id: 't-1' }];
      await expect(s.flow.upgrade(DORA)).rejects.toThrow(/tasks running/);
      expect(s.confirm).not.toHaveBeenCalled();
      expect(s.run).not.toHaveBeenCalled();
    }
  });

  it('checks again after the dialog: a task that started meanwhile stops the upgrade', async () => {
    const s = setup();
    s.confirm.mockImplementation(async () => {
      s.tasks.running = [{ id: 't-2' }];
      return true;
    });
    await expect(s.flow.upgrade(DORA)).rejects.toThrow(/tasks running/);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.flow.busy(DORA)).toBe(false);
  });

  it('does nothing when the dialog is cancelled or the connection changed', async () => {
    const cancelled = setup();
    cancelled.confirm.mockResolvedValue(false);
    expect(await cancelled.flow.upgrade(DORA)).toBe(false);
    const changed = setup();
    changed.confirm.mockImplementation(async () => {
      changed.invalidate();
      return true;
    });
    await expect(changed.flow.upgrade(DORA)).rejects.toThrow(/connection changed/);
    for (const s of [cancelled, changed]) expect(s.run).not.toHaveBeenCalled();
  });

  it('upgrades, waits for the new version and updates outdated VM components', async () => {
    const s = setup();
    expect(await s.flow.upgrade(DORA)).toBe(true);
    expect(s.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Upgrade dora to Anchi 0.4.4?', button: 'Upgrade' }),
    );
    expect(s.run).toHaveBeenCalledWith(DORA);
    expect(s.read).toHaveBeenCalledWith('setup.prepare', { runtime: 'claude-code', confirm: true });
    expect(s.flow.busy(DORA)).toBe(false);
  });

  it('leaves a VM that was never prepared alone, and fails if the old daemon came back', async () => {
    const fresh = setup();
    fresh.setupStatus.installed = false;
    expect(await fresh.flow.upgrade(DORA)).toBe(true);
    expect(fresh.read).not.toHaveBeenCalledWith('setup.prepare', expect.anything());
    const stale = setup();
    stale.run.mockResolvedValue(undefined);
    await expect(stale.flow.upgrade(DORA)).rejects.toThrow(/did not come back/);
    expect(stale.read).not.toHaveBeenCalledWith('setup.prepare', expect.anything());
  });

  it('runs one upgrade per machine at a time', async () => {
    const s = setup();
    let finish = () => {};
    s.run.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            s.daemon.version = '0.4.4';
            resolve();
          };
        }),
    );
    const first = s.flow.upgrade(DORA);
    await vi.waitFor(() => expect(s.run).toHaveBeenCalled());
    expect(s.flow.busy(DORA)).toBe(true);
    await expect(s.flow.upgrade(DORA)).rejects.toThrow(/already running/);
    finish();
    await first;
  });
});

describe('upgrade scripts', () => {
  it('checks for running cells on the server before it installs anything', () => {
    const check = REMOTE_UPGRADE.indexOf('daemon status');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(REMOTE_UPGRADE.indexOf('anchi update'));
    expect(REMOTE_UPGRADE).toMatch(/^set -eu/);
    expect(REMOTE_UPGRADE).toContain('systemctl --user restart anchi-daemon.service');
  });

  it('takes the local CLI as an argument, never as script text', () => {
    expect(LOCAL_UPGRADE).toContain('anchi=$1');
    expect(LOCAL_UPGRADE).toMatch(/^set -eu/);
    // Login startup is rewritten only where it was installed.
    expect(LOCAL_UPGRADE).toMatch(/if \[ -f .*dev\.anchi\.daemon\.plist/);
  });
});

describe('connection versions', () => {
  function connection(status: unknown): Connection {
    return {
      daemon: status as Connection['daemon'],
      read: vi.fn(async () => null),
      on: () => {},
      onClose: () => {},
      close: () => {},
    };
  }

  it('records the daemon version and install kind, and ignores malformed ones', async () => {
    const answers: Record<string, unknown> = {
      local: { version: '0.4.4', install: 'release' },
      [DORA]: { version: '0.4.4\u001b[31m', install: 'other' },
    };
    const pool = new Connections({
      open: async (target) => connection(answers[target]),
      changed: () => {},
      notify: () => {},
    });
    pool.add({ name: 'local', target: 'local' });
    pool.add({ name: 'dora', target: DORA });
    await pool.connect('local');
    await pool.connect(DORA);
    const [local, dora] = pool.states();
    expect(local).toMatchObject({ status: 'connected', version: '0.4.4', install: 'release' });
    expect(dora?.status).toBe('connected');
    expect(dora?.version).toBeUndefined();
    expect(dora?.install).toBeUndefined();
    pool.close();
  });
});
