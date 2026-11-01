import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateLima,
  ensureLima,
  limaPin,
  managedLimaBin,
  parseEnv,
  readHostTools,
  type LimaPin,
} from '../src/lima.ts';
import { SetupRunner } from '../src/host.ts';
import { hostReadiness } from '../src/setup.ts';

const SHA = 'a'.repeat(64);

/** A directory with a `limactl` that reports `version`. */
function fakeLima(version: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'anchi-lima-bin-'));
  writeFileSync(join(bin, 'limactl'), `#!/bin/sh\necho "limactl version ${version}"\n`);
  chmodSync(join(bin, 'limactl'), 0o755);
  return bin;
}

/** A Lima-shaped .tar.gz (bin/limactl at the top) and its pin. */
function archive(version: string): { body: Buffer; pin: LimaPin } {
  const dir = mkdtempSync(join(tmpdir(), 'anchi-lima-tree-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/limactl'), `#!/bin/sh\necho "limactl version ${version}"\n`);
  chmodSync(join(dir, 'bin/limactl'), 0o755);
  const file = join(dir, 'lima.tar.gz');
  expect(spawnSync('tar', ['-czf', file, '-C', dir, 'bin']).status).toBe(0);
  const body = readFileSync(file);
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { body, pin: { version: '2.2.0', sha256, url: 'https://example.invalid/lima.tar.gz' } };
}

describe('managed Lima', () => {
  let path: string | undefined;
  beforeEach(() => {
    path = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = path;
  });

  it('reads the pinned version and checksum for the two supported hosts only', () => {
    const env = parseEnv(
      `# comment\nANCHI_LIMA_VERSION=2.2.0\nANCHI_LIMA_SHA256_DARWIN_ARM64=${SHA}\nANCHI_LIMA_SHA256_LINUX_X64=${'b'.repeat(64)}\n`,
    );
    expect(limaPin(env, 'darwin', 'arm64')).toEqual({
      version: '2.2.0',
      sha256: SHA,
      url: 'https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Darwin-arm64.tar.gz',
    });
    expect(limaPin(env, 'linux', 'x64')?.url).toMatch(/lima-2\.2\.0-Linux-x86_64\.tar\.gz$/);
    expect(limaPin(env, 'darwin', 'x64')).toBeUndefined();
    expect(limaPin(env, 'win32', 'x64')).toBeUndefined();
    // A malformed pin is no pin: setup then asks for Lima instead of downloading something.
    expect(limaPin({ ...env, ANCHI_LIMA_SHA256_DARWIN_ARM64: 'abc' }, 'darwin', 'arm64')).toBe(
      undefined,
    );
    expect(limaPin({ ...env, ANCHI_LIMA_VERSION: '2.2' }, 'darwin', 'arm64')).toBeUndefined();
    // This checkout pins both targets.
    const shipped = readHostTools();
    expect(limaPin(shipped, 'darwin', 'arm64')?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(limaPin(shipped, 'linux', 'x64')).toBeDefined();
  });

  it('keeps a new enough Lima on PATH and prefers the managed one over an old one', () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-lima-home-'));
    const pin = { version: '2.2.0', sha256: SHA, url: 'https://example.invalid/x' };
    process.env.PATH = [fakeLima('2.3.0'), '/usr/bin', '/bin'].join(delimiter);
    expect(activateLima(home, '2.2.0', pin)).toBe('system');
    process.env.PATH = [fakeLima('1.0.0'), '/usr/bin', '/bin'].join(delimiter);
    expect(activateLima(home, '2.2.0', pin)).toBe('none');
    const managed = managedLimaBin(home, '2.2.0');
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, 'limactl'), '#!/bin/sh\necho "limactl version 2.2.0"\n');
    chmodSync(join(managed, 'limactl'), 0o755);
    expect(activateLima(home, '2.2.0', pin)).toBe('managed');
    expect(process.env.PATH.split(delimiter)[0]).toBe(managed);
    // Once only, however often it is asked.
    expect(activateLima(home, '2.2.0', pin)).toBe('managed');
    expect(process.env.PATH.split(delimiter).filter((d) => d === managed)).toHaveLength(1);
  });

  it('downloads, checks and installs the pinned Lima when PATH has none', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-lima-home-'));
    process.env.PATH = '/usr/bin:/bin';
    const { body, pin } = archive('2.2.0');
    const fetch = vi.fn(async () => body);
    const lines: string[] = [];
    await ensureLima(home, '2.2.0', (l) => lines.push(l), { pin, fetch });
    expect(fetch).toHaveBeenCalledWith(pin.url);
    expect(existsSync(join(managedLimaBin(home, '2.2.0'), 'limactl'))).toBe(true);
    expect(process.env.PATH.split(delimiter)[0]).toBe(managedLimaBin(home, '2.2.0'));
    expect(lines[0]).toMatch(/^Downloading Lima 2\.2\.0/);
    // No temporary directory is left behind, and the next run downloads nothing.
    expect(readdirSync(join(home, 'lima'))).toEqual(['2.2.0']);
    await ensureLima(home, '2.2.0', () => {}, { pin, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an archive whose checksum does not match, extracting nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-lima-home-'));
    process.env.PATH = '/usr/bin:/bin';
    const { body, pin } = archive('2.2.0');
    const tampered = Buffer.concat([body, Buffer.from('x')]);
    await expect(
      ensureLima(home, '2.2.0', () => {}, { pin, fetch: async () => tampered }),
    ).rejects.toThrow(/LIMA_CHECKSUM_MISMATCH/);
    expect(existsSync(join(home, 'lima'))).toBe(false);
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('refuses an archive whose limactl is not the pinned version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-lima-home-'));
    process.env.PATH = '/usr/bin:/bin';
    const { body, pin } = archive('1.9.9');
    await expect(
      ensureLima(home, '2.2.0', () => {}, { pin, fetch: async () => body }),
    ).rejects.toThrow(/LIMA_EXTRACT_FAILED: bin\/limactl reports 1\.9\.9/);
    expect(readdirSync(join(home, 'lima'))).toEqual([]);
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('asks for Lima only where Anchi has none to download', () => {
    process.env.PATH = '/usr/bin:/bin';
    const pin = { version: '2.2.0', sha256: SHA, url: 'https://example.invalid/x' };
    expect(hostReadiness('lima', pin).missing).not.toContain('limactl');
    expect(hostReadiness('lima', null).missing).toContain('limactl');
  });

  it('runs the hook before a step, and a failing hook runs none of its commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchi-lima-steps-'));
    const marker = join(dir, 'ran');
    const steps = { 'vm-start': [['touch', marker]] };
    const order: string[] = [];
    const ok = new SetupRunner(steps, dir, null, undefined, async (action, onLine) => {
      order.push(action);
      onLine('hook');
    });
    const lines: string[] = [];
    await ok.run('vm-start', (l) => lines.push(l));
    expect(order).toEqual(['vm-start']);
    expect(lines[0]).toBe('hook');
    expect(existsSync(marker)).toBe(true);

    const other = join(dir, 'other');
    const failing = new SetupRunner({ 'vm-start': [['touch', other]] }, dir, null, undefined, () =>
      Promise.reject(new Error('LIMA_CHECKSUM_MISMATCH')),
    );
    await expect(failing.run('vm-start', () => {})).rejects.toThrow(/LIMA_CHECKSUM_MISMATCH/);
    expect(existsSync(other)).toBe(false);
    expect(failing.running).toBeUndefined();
  });
});
