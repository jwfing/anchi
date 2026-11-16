import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/credentials/store.ts';
import { decrypt, encrypt, VaultError } from '../src/vault/envelope.ts';
import { Vault } from '../src/vault/store.ts';

const KEY = Buffer.alloc(32, 'k');
const KEY_B64 = KEY.toString('base64');
/** Written by services/vault.py (AESGCM, nonce 0..11) for the same key and name. */
const PYTHON_ENVELOPE = {
  version: 1,
  nonce: 'AAECAwQFBgcICQoL',
  ciphertext:
    'Ef+AQW+16Fd5u3HtDLVXPpmF3wL9DfnjzheMw5FB8U7MU1aA9058dpW4FFiSb12ocqPe4eAsSUWRTWWnvbRQod6eL9IZW6TiUNKVnUY0NiwK5MgHuJ9y4DcLpjcVm5+pYD9BCNA=',
};
const PYTHON_VALUE = {
  token: 'ghp_fakefakefakefakefakefakefake',
  generation: 'g1',
  imported_at: 1.5,
};

const dir = () => mkdtempSync(join(tmpdir(), 'anchi-vault-'));

describe('vault envelope', () => {
  it('reads what the Python vault wrote and writes what it reads', () => {
    expect(decrypt('github.json', PYTHON_ENVELOPE, KEY)).toEqual(PYTHON_VALUE);
    // What this side writes, the format reads back; the JSON spacing inside differs from
    // Python's, so the ciphertexts are not byte-equal, only the plaintexts.
    const nonce = Buffer.from(PYTHON_ENVELOPE.nonce, 'base64');
    const written = encrypt('github.json', PYTHON_VALUE, KEY, nonce);
    expect(written.nonce).toBe(PYTHON_ENVELOPE.nonce);
    expect(decrypt('github.json', written, KEY)).toEqual(PYTHON_VALUE);
    // Another name is another associated datum: a file cannot stand in for another.
    expect(() => decrypt('linear.json', PYTHON_ENVELOPE, KEY)).toThrow(VaultError);
    expect(() => decrypt('github.json', PYTHON_ENVELOPE, Buffer.alloc(32, 'x'))).toThrow(
      /VAULT_INTEGRITY_ERROR/,
    );
    for (const broken of [
      { ...PYTHON_ENVELOPE, version: 2 },
      { ...PYTHON_ENVELOPE, nonce: 'AAEC' },
      { ...PYTHON_ENVELOPE, ciphertext: `${PYTHON_ENVELOPE.ciphertext.slice(0, -5)}AAAA=` },
      { ...PYTHON_ENVELOPE, ciphertext: 'not base64!' },
      null,
      'text',
    ]) {
      expect(() => decrypt('github.json', broken, KEY)).toThrow(/VAULT_INTEGRITY_ERROR/);
    }
  });
});

describe('vault store', () => {
  it('unlocks only with a key that opens every stored file, and never writes the key', () => {
    const root = dir();
    const vault = new Vault(root);
    expect(vault.status()).toEqual({ unlocked: false, encrypted_files: 0 });
    expect(() => vault.read('github.json')).toThrow(/VAULT_LOCKED/);
    expect(() => vault.unlock('short')).toThrow(/VAULT_KEY_INVALID/);
    vault.unlock(KEY_B64);
    vault.write('github.json', PYTHON_VALUE);
    expect(statSync(join(root, 'github.json.enc')).mode & 0o777).toBe(0o600);
    expect(vault.read('github.json')).toEqual(PYTHON_VALUE);
    expect(vault.status()).toEqual({ unlocked: true, encrypted_files: 1 });
    // No temporary file is left, and the key is in no file.
    expect(readdirSync(root)).toEqual(['github.json.enc']);
    expect(readFileSync(join(root, 'github.json.enc'), 'utf8')).not.toContain(KEY_B64);
    vault.lock();
    expect(() => vault.read('github.json')).toThrow(/VAULT_LOCKED/);
    // A wrong key is refused and the stored file stays as it was.
    const before = readFileSync(join(root, 'github.json.enc'), 'utf8');
    expect(() => vault.unlock(Buffer.alloc(32, 'w').toString('base64'))).toThrow(
      /VAULT_INTEGRITY_ERROR/,
    );
    expect(vault.unlocked).toBe(false);
    expect(readFileSync(join(root, 'github.json.enc'), 'utf8')).toBe(before);
    vault.unlock(KEY_B64);
    expect(vault.read('github.json')).toEqual(PYTHON_VALUE);
    // Names outside the vault's list are refused before any path is touched.
    expect(() => vault.write('../etc.json', {})).toThrow(/VAULT_NAME_DENIED/);
    expect(() => vault.read('passwd')).toThrow(/VAULT_NAME_DENIED/);
    expect(() => vault.read('linear.json')).toThrow(/NOT_CONNECTED/);
    writeFileSync(join(root, 'linear.json.enc'), 'garbage');
    expect(() => vault.read('linear.json')).toThrow(/VAULT_INTEGRITY_ERROR/);
    vault.remove('linear.json');
    expect(existsSync(join(root, 'linear.json.enc'))).toBe(false);
  });
});

describe('credential store', () => {
  it('imports tokens by shape, reports no secret, and serves the proxy its fields only', () => {
    const vault = new Vault(dir());
    vault.unlock(KEY_B64);
    const store = new CredentialStore(vault);
    expect(store.status().github).toEqual({
      connected: false,
      reauth_required: false,
      account: null,
      scope_text: '',
      revocation_pending: false,
      auth: 'token',
    });
    expect(() => store.importToken('github', 'not-a-token')).toThrow(/BAD_TOKEN_FORMAT/);
    expect(() => store.importToken('gmail', 'x')).toThrow(/UNKNOWN_CONNECTOR/);
    const token = `ghp_${'a'.repeat(36)}`;
    expect(store.importToken('github', token).connected).toBe(true);
    expect(store.setAccount('github', 'octo').account).toBe('octo');
    expect(() => store.setAccount('github', '')).toThrow(/BAD_ACCOUNT_LABEL/);
    expect(JSON.stringify(store.status())).not.toContain(token);
    const credential = store.egressCredential('github');
    expect(credential.token).toBe(token);
    expect(Object.keys(credential).sort()).toEqual(['generation', 'token']);
    expect(() => store.egressCredential('notion')).toThrow(/UNKNOWN_CONNECTOR/);
    expect(() => store.egressCredential('linear')).toThrow(/NOT_CONNECTED/);
    for (const [connector, value] of [
      ['linear', `lin_api_${'b'.repeat(30)}`],
      ['posthog', `phx_${'c'.repeat(30)}`],
      ['sentry', 'a'.repeat(64)],
      ['firecrawl', `fc-${'d'.repeat(24)}`],
      ['figma', `figd_${'e'.repeat(30)}`],
      ['discord', `${'M'.repeat(24)}.AAAAAA.${'f'.repeat(27)}`],
    ] as const) {
      expect(store.importToken(connector, value).connected, connector).toBe(true);
    }
    expect(store.remove('linear').connected).toBe(false);
  });

  it('checks the AWS fields and keeps the session token with its key', () => {
    const vault = new Vault(dir());
    vault.unlock(KEY_B64);
    const store = new CredentialStore(vault);
    const good = {
      access_key_id: 'AKIAI44QH8DHBEXAMPLE',
      secret_access_key: 'fake/secret/key/0000000000',
      region: 'us-east-1',
    };
    for (const [bad, code] of [
      [{ ...good, access_key_id: 'BAD' }, 'BAD_AWS_ACCESS_KEY_ID'],
      [{ ...good, secret_access_key: 'short' }, 'BAD_AWS_SECRET'],
      [{ ...good, region: 'moon' }, 'BAD_AWS_REGION'],
      [{ ...good, session_token: 'x' }, 'BAD_AWS_SESSION_TOKEN'],
      [{ ...good, session_token: 's'.repeat(20) }, 'AWS_SESSION_TOKEN_MISMATCH'],
      [{ ...good, access_key_id: 'ASIAI44QH8DHBEXAMPLE' }, 'AWS_SESSION_TOKEN_MISMATCH'],
    ] as const) {
      expect(() => store.importAws(bad), code).toThrow(code);
    }
    expect(store.importAws(good).account).toBe('AKIA…MPLE');
    const credential = store.egressCredential('aws');
    expect(Object.keys(credential).sort()).toEqual([
      'access_key_id',
      'generation',
      'region',
      'secret_access_key',
    ]);
    store.importAws({
      ...good,
      access_key_id: 'ASIAI44QH8DHBEXAMPLE',
      session_token: 's'.repeat(20),
    });
    expect(store.egressCredential('aws').session_token).toBe('s'.repeat(20));
    vault.lock();
    expect(store.status().aws).toMatchObject({ connected: true, account: null });
  });
});
