import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, managedRoot, selfUpdate } from '../src/update.ts';

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
