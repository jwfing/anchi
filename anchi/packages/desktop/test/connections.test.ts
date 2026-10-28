import { afterEach, describe, expect, it, vi } from 'vitest';
import { Connections, type Connection } from '../src/main/connections.ts';

function wire() {
  const listeners = new Map<string, (params: unknown) => void>();
  let closed = () => {};
  const connection: Connection = {
    read: vi.fn(async () => null),
    on: (name, listener) => {
      listeners.set(name, listener);
    },
    onClose: (listener) => {
      closed = listener;
    },
    close: vi.fn(() => closed()),
  };
  return { connection, emit: (name: string, params: unknown) => listeners.get(name)?.(params) };
}

describe('desktop machine routing', () => {
  const pools: Connections[] = [];
  afterEach(() => pools.splice(0).forEach((pool) => pool.close()));
  function setup() {
    const local = wire();
    const cloud = wire();
    const notify = vi.fn();
    const pool = new Connections({
      open: async (target) => (target === 'local' ? local.connection : cloud.connection),
      changed: () => {},
      notify,
    });
    pools.push(pool);
    pool.add({ name: 'local', target: 'local' });
    pool.add({ name: 'newuser', target: 'instabox:newuser' });
    return { pool, local, cloud, notify };
  }

  it('refuses unknown and disconnected destinations instead of falling back to another daemon', async () => {
    const { pool, local, cloud } = setup();
    await pool.connect('local');
    expect(() => pool.lease('ssh:unregistered')).toThrow(/unknown machine/);
    expect(() => pool.lease('instabox:newuser')).toThrow(/not connected/);
    expect(() => pool.lease(undefined)).toThrow(/unknown machine/);
    await expect(pool.call('local', 'team.run', {}, async () => true)).rejects.toThrow(
      /does not call/,
    );
    expect(local.connection.read).not.toHaveBeenCalled();
    expect(cloud.connection.read).not.toHaveBeenCalled();
  });

  it('never sends a pending confirmed write to a reconnected or different machine', async () => {
    const { pool, local, cloud } = setup();
    await Promise.all([pool.connect('local'), pool.connect('instabox:newuser')]);
    await expect(
      pool.call(
        'instabox:newuser',
        'setup.prepare',
        { runtime: 'codex', confirm: true },
        async (question) => {
          expect(question.detail).toContain('newuser');
          pool.disconnect('instabox:newuser');
          await pool.connect('instabox:newuser');
          return true;
        },
      ),
    ).rejects.toThrow(/connection changed/);
    expect(local.connection.read).not.toHaveBeenCalled();
    expect(cloud.connection.read).toHaveBeenCalledExactlyOnceWith('setup.status', {});
  });

  it('keeps both connections and tags notifications and same-id requests with their machine', async () => {
    const { pool, local, cloud, notify } = setup();
    await Promise.all([pool.connect('local'), pool.connect('instabox:newuser')]);
    await pool.call(
      'instabox:newuser',
      'tasks.send',
      { taskId: 'same', text: 'hello' },
      async () => true,
    );
    expect(cloud.connection.read).toHaveBeenCalledWith('tasks.send', {
      taskId: 'same',
      text: 'hello',
    });
    expect(local.connection.read).not.toHaveBeenCalled();
    cloud.emit('agents', { agents: [] });
    expect(notify).toHaveBeenCalledWith('instabox:newuser', 'agents', { agents: [] });
    pool.disconnect('instabox:newuser');
    cloud.emit('agents', { agents: ['stale'] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(pool.states().find((s) => s.name === 'local')?.status).toBe('connected');
  });

  it('keeps native picker writes pinned and refuses a removed machine', async () => {
    const { pool, local, cloud } = setup();
    await Promise.all([pool.connect('local'), pool.connect('instabox:newuser')]);
    const picked = pool.lease('local');
    pool.remove('local');
    expect(() => picked.read('skills.add', { source: '/chosen/folder' })).toThrow(
      /connection changed/,
    );
    expect(() => pool.lease('local')).toThrow(/unknown machine/);
    expect(local.connection.read).not.toHaveBeenCalled();
    await pool.call('instabox:newuser', 'skills.list', {}, async () => true);
    expect(cloud.connection.read).toHaveBeenCalledExactlyOnceWith('skills.list', {});
  });

  it('discards a slow connection that finishes after the user disconnected', async () => {
    const remote = wire();
    let finish: (connection: Connection) => void = () => {};
    const pool = new Connections({
      open: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      changed: () => {},
      notify: () => {},
    });
    pools.push(pool);
    pool.add({ name: 'newuser', target: 'instabox:newuser' });
    const opening = pool.connect('instabox:newuser');
    pool.disconnect('instabox:newuser');
    finish(remote.connection);
    await opening;
    expect(pool.states()[0]?.status).toBe('disconnected');
    expect(remote.connection.close).toHaveBeenCalledOnce();
    expect(() => pool.lease('instabox:newuser')).toThrow(/not connected/);
  });
});
