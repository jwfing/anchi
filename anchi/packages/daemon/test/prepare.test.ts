import { describe, expect, it } from 'vitest';
import type { SetupAction, SetupStatus } from '@anchi/protocol';
import { prepareEnvironment } from '../src/setup.ts';

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
