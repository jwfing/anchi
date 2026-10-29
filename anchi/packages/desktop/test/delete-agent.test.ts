import type { AgentDeletionPreview } from '@anchi/protocol';
import { describe, expect, it, vi } from 'vitest';
import { checkCall, guardedCall } from '../src/main/bridge.ts';

const preview: AgentDeletionPreview = {
  agentId: 'reviewer',
  exists: true,
  tasks: 4,
  delegated: 2,
  running: 1,
  delegatedBy: ['lead'],
  delegatedByTemplates: ['team'],
  triggers: 1,
  workspaces: ['project'],
};
const params = { agentId: 'reviewer', confirm: 'reviewer' };

describe('desktop agent deletion', () => {
  it('does not delete when the native confirmation is cancelled', async () => {
    const read = vi.fn(async () => preview);
    const confirm = vi.fn(async () => false);
    await expect(guardedCall('agents.delete', params, read, confirm)).rejects.toThrow('cancelled');
    expect(read).toHaveBeenCalledExactlyOnceWith('agents.deletePreview', { agentId: 'reviewer' });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Delete @reviewer?',
        detail: expect.stringContaining('4 tasks and 2 delegated tasks'),
      }),
    );
  });

  it('refuses a missing or incorrect typed id, invalid ids and the built-in builder', () => {
    for (const input of [
      { agentId: 'reviewer' },
      { ...params, confirm: 'lead' },
      { agentId: '../reviewer', confirm: '../reviewer' },
      { agentId: 'builder', confirm: 'builder' },
      { ...params, force: true },
    ])
      expect(() => checkCall('agents.delete', input)).toThrow();
    expect(() => checkCall('agents.deletePreview', { agentId: 'builder' })).toThrow();
  });

  it('requires review again when deletion effects change during native confirmation', async () => {
    const read = vi.fn(async () => preview);
    read.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, tasks: 5 });
    await expect(guardedCall('agents.delete', params, read, async () => true)).rejects.toThrow(
      /changed/,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalledWith('agents.delete', expect.anything());
  });

  it('deletes the confirmed agent after rechecking its current effects', async () => {
    const read = vi.fn(async () => preview);
    await guardedCall('agents.delete', params, read, async () => true);
    expect(read.mock.calls).toEqual([
      ['agents.deletePreview', { agentId: 'reviewer' }],
      ['agents.deletePreview', { agentId: 'reviewer' }],
      ['agents.delete', params],
    ]);
  });

  it('refuses a preview for a different agent', async () => {
    const read = vi.fn(async () => ({ ...preview, agentId: 'other' }));
    const confirm = vi.fn(async () => true);
    await expect(guardedCall('agents.delete', params, read, confirm)).rejects.toThrow(/agent/);
    expect(confirm).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
