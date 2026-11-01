import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/host.ts';

/**
 * scripts/vault.mjs with temporary keys and a fake limactl that records what the vault admin
 * would receive; it never reaches a VM.
 */
function setup(answers: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'anchi-vault-host-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls');
  // The admin action is the last argument; the answer for it is the fake's output.
  const cases = Object.entries(answers)
    .map(([action, answer]) => `  ${action}) printf '%s' '${answer}' ;;`)
    .join('\n');
  writeFileSync(
    join(bin, 'limactl'),
    `#!/bin/sh\nfor a; do last=$a; done\nprintf '%s ' "$@" >>"${log}"\nprintf '| ' >>"${log}"\ncat >>"${log}"\necho >>"${log}"\ncase $last in\n${cases}\n  *) printf '{"error":"UNEXPECTED"}'; exit 1 ;;\nesac\n`,
  );
  chmodSync(join(bin, 'limactl'), 0o755);
  const key = join(dir, 'config/vault.key');
  const run = (action: string) =>
    spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/vault.mjs'), action, '--key-file', key], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ANCHI_VM_MIGRATING: '1' },
      encoding: 'utf8',
    });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [args, stdin] = line.split(' | ');
            return { args: args!.trim().split(' '), stdin: stdin ?? '' };
          })
      : [];
  return { dir, key, run, calls };
}

describe('host vault key (scripts/vault.mjs)', () => {
  it('sends the key to guest-root administration on stdin only, never in output', () => {
    const v = setup({ status: '{"encrypted_files":0}', unlock: '{"unlocked":true}' });
    const init = v.run('init');
    expect(init.status, init.stderr).toBe(0);
    const master = readFileSync(v.key);
    expect(master).toHaveLength(32);
    expect(statSync(v.key).mode & 0o777).toBe(0o600);
    expect(statSync(join(v.dir, 'config')).mode & 0o777).toBe(0o700);
    const encoded = master.toString('base64');
    const [status, unlock] = v.calls();
    expect(status!.args).toEqual([
      'shell',
      'anchi-vm',
      '--',
      'sudo',
      '-n',
      '/usr/bin/python3',
      '/opt/secure-vm/services/vault_admin.py',
      'status',
    ]);
    expect(unlock!.args.at(-1)).toBe('unlock');
    expect(JSON.parse(unlock!.stdin)).toEqual({ key: encoded });
    expect(unlock!.args.join(' ')).not.toContain(encoded);
    expect(init.stdout + init.stderr).not.toContain(encoded);
    expect(JSON.parse(init.stdout)).toEqual({ unlocked: true });
  });

  it('keeps an existing key on a second init and unlocks with it', () => {
    const v = setup({ status: '{"encrypted_files":0}', unlock: '{"unlocked":true}' });
    expect(v.run('init').status).toBe(0);
    const master = readFileSync(v.key);
    const again = setup({ unlock: '{"unlocked":true}' });
    mkdirSync(join(again.dir, 'config'), { mode: 0o700 });
    writeFileSync(again.key, master, { mode: 0o600 });
    expect(again.run('init').status).toBe(0);
    // No status check and no new key: only the unlock with the same key.
    expect(again.calls().map((c) => c.args.at(-1))).toEqual(['unlock']);
    expect(JSON.parse(again.calls()[0]!.stdin)).toEqual({ key: master.toString('base64') });
    expect(readFileSync(again.key)).toEqual(master);
  });

  it('gives recovery steps for a missing key without creating or sending one', () => {
    const v = setup({});
    const result = v.run('unlock');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/VAULT_KEY_MISSING.*setup vault init.*Restore/s);
    expect(v.calls()).toEqual([]);
    expect(existsSync(v.key)).toBe(false);
  });

  it('refuses a replacement key over encrypted credentials', () => {
    const v = setup({ status: '{"encrypted_files":1}' });
    const result = v.run('init');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Restore the original master key/);
    expect(v.calls().map((c) => c.args.at(-1))).toEqual(['status']);
    expect(existsSync(v.key)).toBe(false);
  });

  it('refuses symlinks, loose permissions, directories, pipes and wrong sizes', () => {
    const v = setup({ unlock: '{"unlocked":true}' });
    mkdirSync(join(v.dir, 'config'));
    const target = join(v.dir, 'original');
    writeFileSync(target, Buffer.alloc(32, 'f'), { mode: 0o600 });
    const bad = (pattern: RegExp) => {
      const result = v.run('unlock');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(pattern);
      expect(v.calls()).toEqual([]);
    };
    symlinkSync(target, v.key);
    bad(/Key file cannot be opened safely/);
    // init must not follow the link and write a key over its target either.
    expect(v.run('init').status).toBe(1);
    unlinkSync(v.key);
    writeFileSync(v.key, Buffer.alloc(32, 'f'), { mode: 0o644 });
    chmodSync(v.key, 0o644);
    bad(/Key file must be owned by you/);
    unlinkSync(v.key);
    mkdirSync(v.key);
    bad(/Key file must be owned by you/);
    rmdirSync(v.key);
    expect(spawnSync('mkfifo', ['-m', '600', v.key]).status).toBe(0);
    bad(/Key file must be owned by you/);
    unlinkSync(v.key);
    writeFileSync(v.key, Buffer.alloc(31, 'f'), { mode: 0o600 });
    bad(/Invalid master key file/);
    expect(readFileSync(target)).toEqual(Buffer.alloc(32, 'f'));
  });

  it("reports the vault admin's error, and refuses an unexpected VM name", () => {
    const v = setup({ unlock: '{"error":"VAULT_WRONG_KEY"}' });
    mkdirSync(join(v.dir, 'config'));
    writeFileSync(v.key, Buffer.alloc(32, 'k'), { mode: 0o600 });
    // The fake answers an error with exit 0; the admin's real errors come with exit 1.
    writeFileSync(
      join(v.dir, 'bin/limactl'),
      `#!/bin/sh\ncat >/dev/null\nprintf '{"error":"VAULT_WRONG_KEY"}'\nexit 1\n`,
    );
    const result = v.run('unlock');
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('VAULT_WRONG_KEY');
    const named = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts/vault.mjs'), 'status', '--key-file', v.key],
      {
        env: { PATH: '/usr/bin:/bin', HOME: v.dir, ANCHI_INSTALL_VM: 'secure-vm' },
        encoding: 'utf8',
      },
    );
    expect(named.status).toBe(1);
    expect(named.stderr).toMatch(/ANCHI_INSTALL_VM must look like anchi-vm/);
  });
});
