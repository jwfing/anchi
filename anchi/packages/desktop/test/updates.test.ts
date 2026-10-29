import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseUpdates, releaseUpdate, UPDATE_INTERVAL_MS } from '../src/main/updates.ts';
import { updateSnoozed } from '../src/renderer/updates.tsx';

const release = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });
const response = (tag: string) => new Response(JSON.stringify(release(tag)));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('desktop release notices', () => {
  it('compares numeric versions and only links to the official release tag', () => {
    expect(
      releaseUpdate('0.4.9', { ...release('v0.4.10'), html_url: 'https://evil.test' }),
    ).toEqual({
      currentVersion: '0.4.9',
      version: '0.4.10',
      url: 'https://github.com/jwfing/anchi/releases/tag/v0.4.10',
    });
    expect(releaseUpdate('0.99.99', release('v1.0.0'))?.version).toBe('1.0.0');
    expect(releaseUpdate('0.4.2', release('v0.4.2'))).toBeNull();
    expect(releaseUpdate('0.4.2', release('v0.3.99'))).toBeNull();
  });

  it('refuses draft, prerelease, malformed and unsafe release metadata', () => {
    for (const value of [
      null,
      [],
      'v1.0.0',
      {},
      { ...release('v1.0.0'), draft: true },
      { ...release('v1.0.0'), prerelease: true },
      { ...release('v1.0.0'), prerelease: 'false' },
      release('v1.0.0-beta.1'),
      release('1.0.0'),
      release('v01.0.0'),
      release('v1.0.0/../../evil'),
      release('v9007199254740992.0.0'),
      release('v' + '9'.repeat(100) + '.0.0'),
    ])
      expect(releaseUpdate('0.4.2', value)).toBeNull();
    expect(releaseUpdate('unknown', release('v1.0.0'))).toBeNull();
  });

  it('checks once on start, then every six hours, and stops polling on exit', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response('v0.4.3'));
    const changed = vi.fn();
    const updates = new ReleaseUpdates({ currentVersion: '0.4.2', fetcher, changed });
    updates.start();
    updates.start();
    await updates.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/jwfing/anchi/releases/latest',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ version: '0.4.3' }));
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
    updates.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('deduplicates overlapping checks and recovers after network and rate-limit failures', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const changed = vi.fn();
    const updates = new ReleaseUpdates({ currentVersion: '0.4.2', fetcher, changed });
    let resolve: (value: Response) => void = () => {};
    fetcher.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = updates.check();
    expect(updates.check()).toBe(first);
    resolve(response('v0.4.3'));
    await first;
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await updates.check();
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
    await updates.check();
    expect(updates.available?.version).toBe('0.4.3');
    expect(changed).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(response('v0.4.4'));
    await updates.check();
    expect(updates.available?.version).toBe('0.4.4');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('refuses oversized and non-JSON responses without notifying or blocking a retry', async () => {
    const oversized = JSON.stringify({ ...release('v99.0.0'), body: 'x'.repeat(1024 * 1024) });
    const fetcher = vi.fn(async () => new Response(oversized));
    const changed = vi.fn();
    const updates = new ReleaseUpdates({ currentVersion: '0.4.2', fetcher, changed });
    await updates.check();
    expect(updates.available).toBeNull();
    fetcher.mockResolvedValueOnce(new Response('<html>Sign in to Wi-Fi</html>'));
    await updates.check();
    expect(changed).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(response('v0.4.3'));
    await updates.check();
    expect(updates.available?.version).toBe('0.4.3');
  });

  it('snoozes only the chosen release for 24 hours and tolerates unavailable storage', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null });
    const now = Date.now();
    expect(updateSnoozed('0.4.3', now)).toBe(false);
    storage.set('anchi.update.remindAfter:0.4.3', String(now + 24 * 60 * 60 * 1000));
    expect(updateSnoozed('0.4.3', now)).toBe(true);
    expect(updateSnoozed('0.4.4', now)).toBe(false);
    expect(updateSnoozed('0.4.3', now + 24 * 60 * 60 * 1000)).toBe(false);
    storage.set('anchi.update.remindAfter:0.4.3', 'bad');
    expect(updateSnoozed('0.4.3', now)).toBe(false);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
    });
    expect(updateSnoozed('0.4.3', now)).toBe(false);
  });
});
