import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  latestVersion,
  managedRoot,
  selfUpdate,
  shellQuote,
  staleVersions,
} from '../src/update.ts';

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "anchi update '"));
  dirs.push(root);
  const app = join(root, 'versions/release.test/app');
  mkdirSync(join(app, 'scripts'), { recursive: true });
  writeFileSync(join(app, 'manifest.json'), '{}');
  writeFileSync(join(app, 'scripts/update.sh'), '');
  symlinkSync(app, join(root, 'current'));
  return { root, app };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('self update', () => {
  it('explains a non-JSON answer from GitHub instead of failing with a parse error', async () => {
    await expect(latestVersion(async () => '<html>captive portal</html>')).rejects.toThrow(
      'Could not check GitHub for updates',
    );
    await expect(latestVersion(async () => 'null')).rejects.toThrow('supported stable release');
    await expect(latestVersion(async () => JSON.stringify({ tag_name: 'v1.2.3' }))).resolves.toBe(
      '1.2.3',
    );
  });
  it('compares numeric versions and rejects unsupported tags', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
    expect(() => compareVersions('1.0.0;echo bad', '1.0.0')).toThrow();
    expect(() => compareVersions('1.0.0-beta', '1.0.0')).toThrow();
  });
  it('only accepts the active managed copy, including custom install paths', () => {
    const { root, app } = fixture();
    expect(managedRoot(app)).toBe(realpathSync(root));
    expect(() => managedRoot(join(root, 'versions'))).toThrow('installer-managed');
    rmSync(join(root, 'current'));
    expect(() => managedRoot(app)).toThrow('installer-managed');
  });
  it('checks without requiring a managed installation or installing', async () => {
    const io = { latest: vi.fn(async () => '0.2.2'), install: vi.fn(async () => {}), log: vi.fn() };
    await selfUpdate('/checkout', '0.2.1', true, io);
    expect(io.install).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith('Anchi 0.2.1 → 0.2.2');
  });
  it('pins installation to the checked version and preserves daemon lifetime', async () => {
    const { root, app } = fixture();
    const io = { latest: vi.fn(async () => '0.2.2'), install: vi.fn(async () => {}), log: vi.fn() };
    await selfUpdate(app, '0.2.1', false, io);
    expect(io.install).toHaveBeenCalledExactlyOnceWith(app, realpathSync(root), '0.2.2');
    expect(io.log).toHaveBeenLastCalledWith(expect.stringContaining('After tasks finish'));
  });
  it('lists the older versions to remove after an update, and removes none of them', async () => {
    const { root, app } = fixture();
    const older = join(root, 'versions/release.older/app');
    mkdirSync(older, { recursive: true });
    const io = {
      latest: vi.fn(async () => '0.2.2'),
      install: vi.fn(async () => {
        // The installer adds a version directory and points `current` at it.
        const next = join(root, 'versions/release.next/app');
        mkdirSync(next, { recursive: true });
        rmSync(join(root, 'current'));
        symlinkSync(next, join(root, 'current'));
      }),
      log: vi.fn(),
    };
    await selfUpdate(app, '0.2.1', false, io);
    const listed = io.log.mock.calls.map((c) => String(c[0])).find((m) => m.includes('rm -rf'));
    // The managed root is resolved; the fixture path carries a quote, so the printed command
    // must be quoted for sh.
    const real = realpathSync(root);
    expect(listed).toContain(`rm -rf ${shellQuote(join(real, 'versions/release.older'))}`);
    expect(listed).toContain(shellQuote(join(real, 'versions/release.test')));
    expect(listed).not.toContain('release.next');
    expect(listed).toContain(`ran from ${join(root, 'versions/release.test')}`);
    expect(existsSync(older)).toBe(true);
    expect(staleVersions(root)).toEqual([
      join(root, 'versions/release.older'),
      join(root, 'versions/release.test'),
    ]);
    expect(staleVersions(join(root, 'nowhere'))).toEqual([]);
  });
  it.each(['0.2.1', '0.2.0'])('does not reinstall or downgrade to %s', async (latest) => {
    const { app } = fixture();
    const io = { latest: vi.fn(async () => latest), install: vi.fn(async () => {}), log: vi.fn() };
    await selfUpdate(app, '0.2.1', false, io);
    expect(io.install).not.toHaveBeenCalled();
  });
  it('does not install when the version check fails or report success when installation fails', async () => {
    const { app } = fixture();
    const io = {
      latest: vi.fn(async () => {
        throw new Error('offline');
      }),
      install: vi.fn(async () => {}),
      log: vi.fn(),
    };
    await expect(selfUpdate(app, '0.2.1', false, io)).rejects.toThrow('offline');
    expect(io.install).not.toHaveBeenCalled();
    io.latest.mockResolvedValue('0.2.2' as never);
    io.install.mockRejectedValue(new Error('checksum mismatch'));
    await expect(selfUpdate(app, '0.2.1', false, io)).rejects.toThrow('checksum mismatch');
    expect(io.log).not.toHaveBeenCalledWith(expect.stringContaining('Updated to'));
  });
});
