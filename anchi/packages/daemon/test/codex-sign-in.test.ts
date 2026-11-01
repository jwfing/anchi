import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexSignIn,
  ensureHostCodex,
  hostCodexPin,
  REFRESH_BEFORE_MS,
} from '../src/codex-sign-in.ts';
import { readHostTools, type Pin } from '../src/host-tools.ts';
import { fakeCodex } from './fake-codex.ts';

function setup(mode = 'ok', timeoutMs?: number) {
  const { home, binary } = fakeCodex(mode);
  const lines: string[] = [];
  const signIn = new CodexSignIn({
    home,
    log: (l) => lines.push(l),
    binary: async () => binary,
    timeoutMs,
  });
  const calls = () =>
    existsSync(join(home, 'codex/calls'))
      ? readFileSync(join(home, 'codex/calls'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { method: string; params: unknown })
      : [];
  return { home, signIn, calls, lines };
}

describe('Codex sign-in without a terminal', () => {
  it('returns the page and code, and finishes when Codex reports the login', async () => {
    const { home, signIn, calls } = setup();
    expect(signIn.signedIn()).toBe(false);
    const started = await signIn.start();
    expect(started).toMatchObject({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI',
    });
    await started.done;
    expect(signIn.signedIn()).toBe(true);
    expect(signIn.authFile).toBe(join(home, 'codex/auth.json'));
    expect(calls().map((c) => c.method)).toEqual([
      'initialize',
      'initialized',
      'account/login/start',
    ]);
    expect(calls()[2]!.params).toEqual({ type: 'chatgptDeviceCode' });
  });

  it('refuses a page outside auth.openai.com or a malformed code, starting nothing', async () => {
    for (const mode of ['bad-url', 'bad-code']) {
      const { signIn } = setup(mode);
      await expect(signIn.start()).rejects.toThrow(
        /CODEX_SIGN_IN_FAILED: .*unexpected device code/,
      );
      expect(signIn.signedIn()).toBe(false);
    }
  });

  it('reports a sign-in the user did not finish, or one that timed out', async () => {
    const failed = setup('fail');
    const started = await failed.signIn.start();
    await expect(started.done).rejects.toThrow(/CODEX_SIGN_IN_FAILED: denied in the browser/);
    expect(failed.signIn.signedIn()).toBe(false);
    const slow = setup('silent', 50);
    await expect((await slow.signIn.start()).done).rejects.toThrow(/code expired/);
  });

  it('cancels a pending sign-in, and a new one replaces it', async () => {
    const { signIn, calls } = setup('silent');
    const first = await signIn.start();
    const second = await signIn.start();
    expect(second.userCode).toBe('ABCD-EFGHI');
    expect(calls().filter((c) => c.method === 'account/login/cancel')).toEqual([
      { method: 'account/login/cancel', params: { loginId: 'login-1' } },
    ]);
    await signIn.cancel();
    expect(calls().filter((c) => c.method === 'account/login/cancel')).toHaveLength(2);
    // The replaced sign-in ends at once as cancelled, never later as an expired code.
    await expect(first.done).rejects.toThrow(/^CODEX_SIGN_IN_CANCELLED/);
    await expect(second.done).rejects.toThrow(/^CODEX_SIGN_IN_CANCELLED/);
    await signIn.cancel(); // nothing pending: no call
    expect(calls().filter((c) => c.method === 'account/login/cancel')).toHaveLength(2);
  });

  it('asks Codex to refresh only a sign-in made here, and only when it is due', async () => {
    const { signIn, calls } = setup();
    const now = Date.now();
    expect(await signIn.refreshIfDue(null, now)).toBe(false); // not signed in here
    await (
      await signIn.start()
    ).done;
    expect(await signIn.refreshIfDue(now + REFRESH_BEFORE_MS + 60_000, now)).toBe(false);
    expect(await signIn.refreshIfDue(now + 3600_000, now)).toBe(true);
    expect(await signIn.refreshIfDue(null, now)).toBe(true); // unreadable or expired
    expect(calls().filter((c) => c.method === 'account/read')).toEqual([
      { method: 'account/read', params: { refreshToken: true } },
      { method: 'account/read', params: { refreshToken: true } },
    ]);
  });
});

describe('the pinned host Codex', () => {
  /** A release-shaped .tar.gz: one `codex-<target>` executable that reports `version`. */
  function archive(version: string, name = 'codex-aarch64-apple-darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'anchi-codex-tree-'));
    writeFileSync(join(dir, name), `#!/bin/sh\necho "codex-cli ${version}"\n`);
    chmodSync(join(dir, name), 0o755);
    expect(spawnSync('tar', ['-czf', join(dir, 'c.tgz'), '-C', dir, name]).status).toBe(0);
    const body = readFileSync(join(dir, 'c.tgz'));
    const pin: Pin = {
      version: '0.160.1',
      sha256: createHash('sha256').update(body).digest('hex'),
      url: 'https://example.invalid/codex.tar.gz',
    };
    return { body, pin };
  }

  it('reads the pin for the two supported hosts', () => {
    const env = readHostTools();
    expect(hostCodexPin(env, 'darwin', 'arm64')?.url).toMatch(
      /^https:\/\/github\.com\/openai\/codex\/releases\/download\/rust-v\d+\.\d+\.\d+\/codex-aarch64-apple-darwin\.tar\.gz$/,
    );
    expect(hostCodexPin(env, 'linux', 'x64')?.url).toMatch(/codex-x86_64-unknown-linux-musl/);
    expect(hostCodexPin(env, 'darwin', 'x64')).toBeUndefined();
  });

  it('installs the checked archive once, as <home>/tools/codex/<version>/codex', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-codex-home-'));
    const { body, pin } = archive('0.160.1');
    let fetched = 0;
    const fetch = async () => (fetched++, body);
    const binary = await ensureHostCodex(home, () => {}, { pin, fetch });
    expect(binary).toBe(join(home, 'tools/codex/0.160.1/codex'));
    expect(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout).toMatch(/0\.160\.1/);
    expect(await ensureHostCodex(home, () => {}, { pin, fetch })).toBe(binary);
    expect(fetched).toBe(1);
    expect(readdirSync(join(home, 'tools/codex'))).toEqual(['0.160.1']);
  });

  it('refuses a mismatched checksum, unexpected contents or another version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-codex-home-'));
    const good = archive('0.160.1');
    await expect(
      ensureHostCodex(home, () => {}, {
        pin: good.pin,
        fetch: async () => Buffer.concat([good.body, Buffer.from('x')]),
      }),
    ).rejects.toThrow(/CODEX_CHECKSUM_MISMATCH/);
    expect(existsSync(join(home, 'tools'))).toBe(false);
    const odd = archive('0.160.1', 'not-codex');
    await expect(
      ensureHostCodex(home, () => {}, { pin: odd.pin, fetch: async () => odd.body }),
    ).rejects.toThrow(/CODEX_EXTRACT_FAILED: unexpected archive contents/);
    const old = archive('0.150.0');
    await expect(
      ensureHostCodex(home, () => {}, { pin: old.pin, fetch: async () => old.body }),
    ).rejects.toThrow(/CODEX_EXTRACT_FAILED: codex reports 0\.150\.0/);
    expect(readdirSync(join(home, 'tools/codex'))).toEqual([]);
  });
});
