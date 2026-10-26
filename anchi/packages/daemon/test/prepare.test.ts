import { describe, expect, it } from 'vitest';
import type { SetupAction, SetupStatus } from '@anchi/protocol';
import { Guest, type ExecResult, type VmTransport } from '../src/guest.ts';
import { APP_VERSION } from '../src/host.ts';
import { prepareEnvironment, setupStatus } from '../src/setup.ts';

const ready = {
  vm: 'running',
  installed: true,
  vaultUnlocked: true,
  preparedRuntimes: ['codex'],
} as SetupStatus;

describe('automatic preparation', () => {
  it('does not report success when the prepared layer is still missing', async () => {
    await expect(
      prepareEnvironment(
        'hermes',
        async () => ready,
        async () => {},
        async () => {},
      ),
    ).rejects.toThrow('Preparation of hermes did not finish');
  });
  it('refuses unknown VM state and missing prerequisites before changing anything', async () => {
    for (const status of [
      { ...ready, vm: 'unknown' },
      { ...ready, host: { missing: ['limactl'], installHint: 'Install Lima' } },
      { ...ready, error: 'guest unavailable' },
    ]) {
      const calls: string[] = [];
      await expect(
        prepareEnvironment(
          'codex',
          async () => status as SetupStatus,
          async (action) => {
            calls.push(action);
          },
          async () => {
            calls.push('image');
          },
        ),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  it('stops at an unlock failure without replacing the key or building a runtime', async () => {
    const calls: string[] = [];
    await expect(
      prepareEnvironment(
        'codex',
        async () => ({ ...ready, vaultUnlocked: false, vaultKeyPresent: true }),
        async (action) => {
          calls.push(action);
          throw new Error('original key required');
        },
        async () => {
          calls.push('image');
        },
      ),
    ).rejects.toThrow('original key required');
    expect(calls).toEqual(['vault-unlock']);
  });

  it('resumes the missing steps, then prepares only the selected runtime', async () => {
    let status = {
      ...ready,
      vm: 'stopped',
      vaultUnlocked: false,
      vaultKeyPresent: false,
      preparedRuntimes: [],
    } as SetupStatus;
    const calls: string[] = [];
    const result = await prepareEnvironment(
      'claude-code',
      async () => status,
      async (action: SetupAction) => {
        calls.push(action);
        if (action === 'vm-start') status = { ...status, vm: 'running' };
        if (action === 'vault-init') status = { ...status, vaultUnlocked: true };
      },
      async (runtime) => {
        calls.push(runtime);
        status = { ...status, preparedRuntimes: [runtime] };
      },
    );
    expect(calls).toEqual(['vm-start', 'vault-init', 'claude-code']);
    expect(result.preparedRuntimes).toEqual(['claude-code']);
    calls.length = 0;
    await prepareEnvironment(
      'claude-code',
      async () => status,
      async (action) => {
        calls.push(action);
      },
      async (runtime) => {
        calls.push(runtime);
      },
    );
    expect(calls).toEqual([]);
  });
});

describe('a running server before its first install', () => {
  /** A running guest where `test -f` answers with `testCode`; every service script is missing. */
  const server = (testCode: number) => {
    const transport = {
      placement: 'local',
      vmStatus: async () => 'running',
      vmSize: async () => undefined,
      exec: async (args: string[]): Promise<ExecResult> =>
        args[0] === 'test'
          ? { code: testCode, stdout: '', stderr: testCode === 255 ? 'ssh: lost' : '' }
          : {
              code: 2,
              stdout: '',
              stderr: `/usr/bin/python3: can't open file '${args[1]}': [Errno 2] No such file or directory`,
            },
      spawn: () => {
        throw new Error('unused');
      },
    } as unknown as VmTransport;
    return { guest: new Guest(transport), transport };
  };

  it('reports it as not installed, so preparing installs it', async () => {
    const { guest, transport } = server(1);
    const status = await setupStatus(guest, transport);
    expect(status).toMatchObject({ vm: 'running', installed: false });
    expect(status.error).toBeUndefined();

    const calls: string[] = [];
    await expect(
      prepareEnvironment(
        'codex',
        async () => status,
        async (action) => {
          calls.push(action);
          throw new Error('stop after the first step');
        },
        async () => {},
      ),
    ).rejects.toThrow('stop after the first step');
    expect(calls).toEqual(['install']);
  });

  it('still reports an error when the guest cannot be asked, and prepares nothing', async () => {
    const { guest, transport } = server(255);
    const status = await setupStatus(guest, transport);
    expect(status.error).toMatch(/can't open file|GUEST_UNAVAILABLE/);
    const calls: string[] = [];
    await expect(
      prepareEnvironment(
        'codex',
        async () => status,
        async (action) => void calls.push(action),
        async () => {},
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('a guest whose vault is locked (after a restart)', () => {
  /** Installed and running; every credential read is refused as the vault is locked. */
  const locked = () => {
    const transport = {
      placement: 'local',
      vmStatus: async () => 'running',
      vmSize: async () => undefined,
      exec: async (args: string[]): Promise<ExecResult> => {
        const json = (value: unknown, code = 0) => ({
          code,
          stdout: JSON.stringify(value),
          stderr: '',
        });
        if (args[0] === 'test') return { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'mountpoint') return { code: 1, stdout: '', stderr: '' };
        if (args[1]?.endsWith('vault_admin.py')) return json({ unlocked: false });
        if (args[0] === 'anchi-image') return json({ present: true });
        if (args[0] === 'anchi-cell') return json({ runtime_version: APP_VERSION });
        return json({ error: 'VAULT_LOCKED' }, 1);
      },
      spawn: () => {
        throw new Error('unused');
      },
    } as unknown as VmTransport;
    return { guest: new Guest(transport), transport };
  };

  it('reports it installed and locked, not broken, so preparing unlocks it', async () => {
    const { guest, transport } = locked();
    const status = await setupStatus(guest, transport);
    expect(status.error).toBeUndefined();
    expect(status).toMatchObject({ installed: true, vaultUnlocked: false });
    expect(status.preparedRuntimes).toContain('codex');

    const calls: SetupAction[] = [];
    await expect(
      prepareEnvironment(
        'codex',
        async () => status,
        async (action) => {
          calls.push(action);
          throw new Error('stop after the first step');
        },
        async () => {},
      ),
    ).rejects.toThrow('stop after the first step');
    expect(calls).toEqual(['vault-unlock']);
  });
});
