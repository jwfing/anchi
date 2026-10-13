import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HostLogins, claudeKeychainService, readHostCodexLogin } from '../src/host-logins.ts';

const token = 'sk-ant-oat01-' + 'fake'.repeat(12);
const expiresAt = () => Date.now() + 3_600_000;
const claude = (expires = expiresAt()) => ({
  claudeAiOauth: {
    accessToken: token,
    refreshToken: 'fake-refresh-must-stay-local',
    expiresAt: expires,
  },
});
const codex = () => ({
  tokens: {
    access_token: `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt() / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } })).toString('base64url')}.s`,
    account_id: 'acct',
    refresh_token: 'fake-refresh-must-stay-local',
  },
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'anchi-host-logins-'));
  const codexFile = join(dir, 'auth.json');
  const claudeFile = join(dir, '.credentials.json');
  const options = { codexFile, claudeDir: dir, path: dir, platform: 'linux' };
  return { dir, codexFile, claudeFile, options };
}

describe('host runtime logins', () => {
  it('refuses malformed, oversized, expired and linked files without exposing their contents', async () => {
    const f = fixture();
    const secret = 'fake-private-value';
    for (const text of [
      `{"${secret}`,
      'x'.repeat(65_537),
      JSON.stringify(claude(1)),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    ]) {
      writeFileSync(f.claudeFile, text);
      const logins = new HostLogins(f.options);
      expect((await logins.read()).claude).toBeNull();
      expect(JSON.stringify(logins.status)).not.toContain(secret);
      expect(logins.status.claude.state).not.toBe('ready');
    }
    const target = join(f.dir, 'target');
    writeFileSync(target, JSON.stringify(codex()));
    symlinkSync(target, f.codexFile);
    expect(() => readHostCodexLogin(f.codexFile)).toThrow('HOST_LOGIN_UNAVAILABLE');
    writeFileSync(
      f.claudeFile,
      JSON.stringify({ claudeAiOauth: { accessToken: token + '\n', expiresAt: expiresAt() } }),
    );
    expect((await new HostLogins(f.options).read()).claude).toBeNull();
  });

  it('refuses a Codex account mismatch and JSON parser errors without echoing tokens', () => {
    const f = fixture();
    const value = codex();
    value.tokens.account_id = 'other';
    writeFileSync(f.codexFile, JSON.stringify(value));
    expect(() => readHostCodexLogin(f.codexFile)).toThrow('HOST_LOGIN_UNAVAILABLE');
    writeFileSync(f.codexFile, '{"fake-private-value');
    expect(() => readHostCodexLogin(f.codexFile)).toThrow('HOST_LOGIN_UNAVAILABLE');
  });

  it('detects both installed CLIs and returns only access credentials from valid files', async () => {
    const f = fixture();
    for (const name of ['codex', 'claude']) {
      writeFileSync(join(f.dir, name), '');
      chmodSync(join(f.dir, name), 0o700);
    }
    writeFileSync(f.codexFile, JSON.stringify(codex()));
    writeFileSync(f.claudeFile, JSON.stringify(claude()));
    const logins = new HostLogins(f.options);
    const found = await logins.read();
    expect(logins.status).toEqual({
      codex: { installed: true, state: 'ready' },
      claude: { installed: true, state: 'ready' },
    });
    expect(found.codex?.accountId).toBe('acct');
    expect(found.claude?.token).toBe(token);
    expect(JSON.stringify(found)).not.toContain('fake-refresh-must-stay-local');
    expect(JSON.stringify(logins.status)).not.toContain(token);
  });

  it('distinguishes installation from login and never executes detected CLIs', async () => {
    const f = fixture();
    mkdirSync(join(f.dir, 'codex'));
    writeFileSync(join(f.dir, 'claude'), 'exit 1');
    chmodSync(join(f.dir, 'claude'), 0o700);
    const logins = new HostLogins(f.options);
    expect(await logins.read()).toEqual({ codex: null, claude: null });
    expect(logins.status.codex.installed).toBe(false);
    expect(logins.status.claude).toEqual({ installed: true, state: 'missing' });
  });

  it('reads only the configured macOS Keychain entry and strips refresh tokens', async () => {
    const f = fixture();
    const keychainRead = vi.fn(async () => JSON.stringify(claude()));
    const logins = new HostLogins({
      ...f.options,
      platform: 'darwin',
      keychainService: 'Claude Code-credentials-custom',
      keychainRead,
    });
    expect((await logins.read()).claude?.token).toBe(token);
    expect(keychainRead).toHaveBeenCalledWith('Claude Code-credentials-custom');
    expect(claudeKeychainService(undefined)).toBe('Claude Code-credentials');
    expect(claudeKeychainService('/tmp/custom')).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
    expect(claudeKeychainService('/tmp/e\u0301')).toBe(claudeKeychainService('/tmp/é'));
  });

  it('uses the macOS file fallback and honors disabled imports without reading Keychain', async () => {
    const f = fixture();
    writeFileSync(f.claudeFile, JSON.stringify(claude()));
    const keychainRead = vi.fn(async (): Promise<string | null> => null);
    const logins = new HostLogins({ ...f.options, platform: 'darwin', keychainRead });
    expect((await logins.read()).claude?.token).toBe(token);
    keychainRead.mockClear();
    expect(await logins.read({ codex: false, claude: false })).toEqual({
      codex: null,
      claude: null,
    });
    expect(keychainRead).not.toHaveBeenCalled();
    expect(logins.status.claude.state).toBe('disabled');
    keychainRead.mockRejectedValue(new Error('fake-secret-error'));
    expect((await logins.read()).claude).toBeNull();
    expect(JSON.stringify(logins.status)).not.toContain('fake-secret-error');
  });
});
