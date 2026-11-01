import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeSignIn,
  codePageFrom,
  ensureHostClaude,
  hostClaudePin,
  ptyCommand,
  tokenFrom,
} from '../src/claude-sign-in.ts';
import { readHostTools, type Pin } from '../src/host-tools.ts';
import { fakeClaude, LOCAL, PASTE, TOKEN } from './fake-claude.ts';

function setup(mode: string, browserHere: boolean, timeoutMs?: number) {
  const { home, binary } = fakeClaude(mode);
  const stored: string[] = [];
  const signIn = new ClaudeSignIn({
    home,
    log: () => {},
    browserHere,
    store: async (token) => void stored.push(token),
    binary: async () => binary,
    timeoutMs,
  });
  return { home, signIn, stored };
}

// Each case runs the CLI in a real pseudo-terminal, several in a row under a loaded test run.
describe('Claude sign-in without a terminal', { timeout: 20_000 }, () => {
  it('finishes by itself through localhost when the browser is on this computer', async () => {
    const { home, signIn, stored } = setup('auto', true);
    const started = await signIn.start();
    expect(started).toMatchObject({ url: LOCAL, codeRequired: false });
    await started.done;
    expect(stored).toEqual([TOKEN]);
    // The private configuration directory is gone once the sign-in ends.
    expect(readdirSync(join(home, 'run'))).toEqual([]);
  });

  it('takes the code the page shows when the browser is elsewhere (a remote server)', async () => {
    const { signIn, stored } = setup('code', false);
    const started = await signIn.start();
    expect(started).toMatchObject({ url: PASTE, codeRequired: true });
    expect(() => signIn.submitCode('not a code; rm -rf /')).toThrow(/not a sign-in code/);
    signIn.submitCode('GOOD#CODE-123');
    await started.done;
    expect(stored).toEqual([TOKEN]);
    expect(() => signIn.submitCode('GOOD#CODE-123')).toThrow(/no sign-in is waiting/);
  });

  it('stores nothing for a wrong code, a CLI that gives up, or a malformed token', async () => {
    const wrong = setup('code', false);
    const started = await wrong.signIn.start();
    wrong.signIn.submitCode('WRONG#CODE-999');
    await expect(started.done).rejects.toThrow(/CLAUDE_SIGN_IN_FAILED: the sign-in did not finish/);
    for (const mode of ['fail', 'bad']) {
      const s = setup(mode, true);
      await expect((await s.signIn.start()).done).rejects.toThrow(/did not finish/);
      expect(s.stored).toEqual([]);
    }
    expect(wrong.stored).toEqual([]);
  });

  it('ends a pending sign-in when cancelled or replaced, and reports a silent CLI', async () => {
    const { signIn, stored } = setup('code', false);
    const first = await signIn.start();
    const second = await signIn.start();
    await expect(first.done).rejects.toThrow(/^CLAUDE_SIGN_IN_CANCELLED/);
    await signIn.cancel();
    await expect(second.done).rejects.toThrow(/^CLAUDE_SIGN_IN_CANCELLED/);
    expect(stored).toEqual([]);
    const slow = setup('code', false, 1500);
    await expect((await slow.signIn.start()).done).rejects.toThrow(/timed out/);
  });

  it('reads a wrapped token and the paste page out of terminal output', () => {
    const raw = `\x1b[2K✓ done\r\nYour OAuth token (valid for 1 year):\r\n\r\n${TOKEN.slice(0, 50)}\r\n${TOKEN.slice(50)}\r\n\r\nStore this token securely.`;
    expect(tokenFrom(raw)).toBe(TOKEN);
    expect(tokenFrom(raw.replace(TOKEN.slice(50), 'x'))).toBeUndefined();
    expect(tokenFrom('valid for 1 year):\nsk-ant-api03-abc\nStore this token')).toBeUndefined();
    expect(codePageFrom(`open ${LOCAL} or ${PASTE}`)).toBe(PASTE);
    expect(codePageFrom(LOCAL)).toBeUndefined();
    // As Claude Code prints it: the whole URL in the OSC 8 link, the visible text wrapped.
    const wrapped = `\x1b]8;id=1;${PASTE}\x07${PASTE.slice(0, 80)}\r\n${PASTE.slice(80)}\x1b]8;;\x07`;
    expect(codePageFrom(wrapped)).toBe(PASTE);
    // Only Claude's own authorize page counts.
    expect(codePageFrom(PASTE.replace('claude.com/cai', 'evil.example/cai'))).toBeUndefined();
  });

  it('runs the CLI in a pseudo-terminal on both hosts, its stdin relayed as a pipe', () => {
    expect(ptyCommand('/a b/claude', 'darwin')).toEqual({
      command: '/bin/bash',
      args: [
        '-c',
        'exec "$0" "$@" < <(exec cat)',
        '/usr/bin/script',
        '-q',
        '/dev/null',
        '/a b/claude',
        'setup-token',
      ],
    });
    expect(ptyCommand("/o'k/claude", 'linux').args.slice(2)).toEqual([
      'script',
      '-q',
      '-e',
      '-c',
      `'/o'\\''k/claude' setup-token`,
      '/dev/null',
    ]);
  });
});

describe('the pinned host Claude Code', () => {
  function archive(version: string, path = 'package/claude') {
    const dir = mkdtempSync(join(tmpdir(), 'anchi-claude-tree-'));
    mkdirSync(join(dir, 'package'));
    writeFileSync(join(dir, path), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(join(dir, path), 0o755);
    expect(spawnSync('tar', ['-czf', join(dir, 'c.tgz'), '-C', dir, 'package']).status).toBe(0);
    const body = readFileSync(join(dir, 'c.tgz'));
    const pin: Pin = {
      version: '2.1.291',
      sha256: createHash('sha256').update(body).digest('hex'),
      url: 'https://example.invalid/claude.tgz',
    };
    return { body, pin };
  }

  it("pins the npm registry's native package for the two supported hosts", () => {
    const env = readHostTools();
    expect(hostClaudePin(env, 'darwin', 'arm64')?.url).toMatch(
      /^https:\/\/registry\.npmjs\.org\/@anthropic-ai\/claude-code-darwin-arm64\/-\/claude-code-darwin-arm64-\d+\.\d+\.\d+\.tgz$/,
    );
    expect(hostClaudePin(env, 'linux', 'x64')?.url).toMatch(/claude-code-linux-x64-/);
    expect(hostClaudePin(env, 'win32', 'x64')).toBeUndefined();
  });

  it('installs the checked package once and refuses a mismatch or another version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anchi-claude-home-'));
    const good = archive('2.1.291');
    await expect(
      ensureHostClaude(home, () => {}, {
        pin: good.pin,
        fetch: async () => Buffer.concat([good.body, Buffer.from('x')]),
      }),
    ).rejects.toThrow(/CLAUDE_CHECKSUM_MISMATCH/);
    expect(existsSync(join(home, 'tools'))).toBe(false);
    const old = archive('2.0.0');
    await expect(
      ensureHostClaude(home, () => {}, { pin: old.pin, fetch: async () => old.body }),
    ).rejects.toThrow(/CLAUDE_EXTRACT_FAILED: package\/claude reports 2\.0\.0/);
    let fetched = 0;
    const fetch = async () => (fetched++, good.body);
    const binary = await ensureHostClaude(home, () => {}, { pin: good.pin, fetch });
    expect(binary).toBe(join(home, 'tools/claude/2.1.291/package/claude'));
    expect(await ensureHostClaude(home, () => {}, { pin: good.pin, fetch })).toBe(binary);
    expect(fetched).toBe(1);
  });
});
