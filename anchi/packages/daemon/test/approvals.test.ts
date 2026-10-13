import { describe, expect, it } from 'vitest';
import { ApprovalWatcher } from '../src/approvals.ts';
import { Guest, type GuestTransport } from '../src/guest.ts';

describe('full connector approval content', () => {
  const setup = (params: Record<string, unknown>) => {
    const transport = {
      exec: async () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 'a'.repeat(32),
          digest: 'd'.repeat(64),
          state: 'PENDING',
          principal: 'reddit:dev',
          created: Date.now() / 1000,
          expires: Date.now() / 1000 + 600,
          action: { operation: 'reddit.submit', params },
        }),
      }),
    } as unknown as GuestTransport;
    return { watcher: new ApprovalWatcher(transport), guest: new Guest(transport) };
  };

  it('retains the end of a long post and the verified account for review', async () => {
    const params = {
      subreddit: 'test',
      title: 'Title',
      text: '中'.repeat(9990) + 'END-OF-POST',
      account_id: 'abc',
      account_label: 'u/example',
    };
    const { watcher, guest } = setup(params);
    try {
      await watcher.addPolicy(guest, { id: 't-test', agentId: 'dev' }, 'reddit', 'a'.repeat(32));
      expect(JSON.parse(watcher.list()[0]!.summary)).toEqual(params);
    } finally {
      watcher.stop();
    }
  });

  it('refuses oversized approval content instead of offering a truncated approval', async () => {
    const { watcher, guest } = setup({ text: 'a'.repeat(65536) });
    try {
      await expect(
        watcher.addPolicy(guest, { id: 't-test', agentId: 'dev' }, 'reddit', 'a'.repeat(32)),
      ).rejects.toThrow(/too large/);
      expect(watcher.list()).toEqual([]);
    } finally {
      watcher.stop();
    }
  });
});
