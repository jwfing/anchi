import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult, SavedServer } from '@anchi/daemon/client';
import { ServerSetup } from '../src/main/server-setup.ts';

function setup() {
  let servers: SavedServer[] = [{ name: 'dora', target: 'instabox:anchi-dora' }];
  let current = true;
  const probe = vi.fn(async (): Promise<ProbeResult> => ({
    kind: 'bridge-missing',
    detail: 'anchi-bridge: command not found',
    hint: 'scripts/remote.sh instabox:anchi-dora',
  }));
  const confirm = vi.fn(async () => true);
  const install = vi.fn(async () => {});
  const connect = vi.fn(async () => {});
  const flow = new ServerSetup({
    servers: () => servers,
    pin: () => () => {
      if (!current) throw new Error('machine changed');
    },
    probe,
    confirm,
    install,
    connect,
  });
  return {
    flow,
    probe,
    confirm,
    install,
    connect,
    replace: (next: SavedServer[]) => {
      servers = next;
    },
    invalidate: () => {
      current = false;
    },
  };
}

describe('remote initialization authorization', () => {
  it('refuses local, unknown and malformed destinations without executing a command', async () => {
    const s = setup();
    for (const target of ['local', 'instabox:unknown', 'ssh:-oProxyCommand=bad', null, {}]) {
      await expect(s.flow.initialize(target)).rejects.toThrow(/saved remote machine/);
    }
    expect(s.probe).not.toHaveBeenCalled();
    expect(s.install).not.toHaveBeenCalled();
  });

  it('does not install when confirmation is cancelled', async () => {
    const s = setup();
    s.confirm.mockResolvedValue(false);
    expect(await s.flow.initialize('instabox:anchi-dora')).toBe(false);
    expect(s.install).not.toHaveBeenCalled();
    expect(s.connect).not.toHaveBeenCalled();
  });

  it('refuses a removed, renamed or replaced machine after confirmation', async () => {
    for (const replacement of [
      [],
      [{ name: 'different', target: 'instabox:anchi-dora' }],
      [{ name: 'dora', target: 'instabox:other' }],
    ]) {
      const s = setup();
      s.confirm.mockImplementation(async () => {
        s.replace(replacement);
        return true;
      });
      await expect(s.flow.initialize('instabox:anchi-dora')).rejects.toThrow(/machine changed/);
      expect(s.install).not.toHaveBeenCalled();
    }
    const s = setup();
    s.confirm.mockImplementation(async () => {
      s.invalidate();
      return true;
    });
    await expect(s.flow.initialize('instabox:anchi-dora')).rejects.toThrow(/machine changed/);
    expect(s.install).not.toHaveBeenCalled();
  });

  it('does not turn an SSH failure into permission to install', async () => {
    const s = setup();
    s.probe.mockResolvedValue({ kind: 'unreachable', detail: 'SSH login failed' });
    await expect(s.flow.initialize('instabox:anchi-dora')).rejects.toThrow('SSH login failed');
    expect(s.confirm).not.toHaveBeenCalled();
    expect(s.install).not.toHaveBeenCalled();
  });

  it('pins the confirmed target and connects only after the daemon answers', async () => {
    const s = setup();
    s.probe.mockResolvedValueOnce({ kind: 'bridge-missing', detail: 'missing', hint: 'manual' });
    s.probe.mockResolvedValueOnce({ kind: 'ok' });
    expect(await s.flow.initialize('instabox:anchi-dora')).toBe(true);
    expect(s.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining('dora (instabox:anchi-dora)'),
      }),
    );
    expect(s.install).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'instabox:anchi-dora' }),
    );
    expect(s.connect).toHaveBeenCalledExactlyOnceWith('instabox:anchi-dora');
  });

  it('keeps a failed initialization retryable and refuses duplicate runs', async () => {
    const s = setup();
    s.confirm.mockImplementationOnce(async () => {
      await expect(s.flow.initialize('instabox:anchi-dora')).rejects.toThrow(/already running/);
      return true;
    });
    s.install.mockRejectedValueOnce(new Error('download failed'));
    await expect(s.flow.initialize('instabox:anchi-dora')).rejects.toThrow('download failed');
    expect(s.connect).not.toHaveBeenCalled();
    s.probe.mockResolvedValue({ kind: 'ok' });
    expect(await s.flow.initialize('instabox:anchi-dora')).toBe(true);
    expect(s.install).toHaveBeenCalledTimes(1);
  });

  it('does not report success when installation exits but the daemon still cannot be reached', async () => {
    const s = setup();
    s.probe.mockResolvedValueOnce({ kind: 'bridge-missing', detail: 'missing', hint: 'manual' });
    s.probe.mockResolvedValueOnce({ kind: 'error', detail: 'daemon socket absent' });
    await expect(s.flow.initialize('instabox:anchi-dora')).rejects.toThrow('daemon socket absent');
    expect(s.install).toHaveBeenCalledOnce();
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.flow.busy('instabox:anchi-dora')).toBe(false);
  });
});
