// Keep the master key out of the guest's services and out of the long-running daemon: this short
// process reads it and sends it on stdin to guest-root administration, which keeps it in tmpfs.
// From a Lima host the key stays outside the VM; with Anchi inside the guest (ANCHI_GUEST=local)
// it stays in the login user's home, which neither task cells nor trusted services read.
// The daemon runs it with its own Node under `ulimit -c 0` (anchi/packages/daemon/src/host.ts).
//   node scripts/vault.mjs init|unlock|lock|status [--key-file <path>]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VM = process.env.ANCHI_INSTALL_VM ?? 'anchi-vm';
const IN_GUEST = (process.env.ANCHI_GUEST ?? 'lima') === 'local';

class Refused extends Error {}

function refuse(message) {
  throw new Refused(message);
}

function remote(action, value) {
  const result = spawnSync(
    IN_GUEST ? 'sudo' : 'limactl',
    [
      ...(IN_GUEST ? [] : ['shell', VM, '--', 'sudo']),
      '-n',
      '/usr/bin/python3',
      '/opt/secure-vm/services/vault_admin.py',
      action,
    ],
    { input: value === undefined ? '' : JSON.stringify(value), encoding: 'utf8' },
  );
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    refuse('Cannot contact vault admin; no secret output displayed.');
  }
  if (result.status !== 0) refuse(response?.error ?? 'VAULT_OPERATION_FAILED');
  return response;
}

/** The 32-byte key, refusing links, pipes, other owners and group or world access. */
function readKey(file) {
  let fd;
  try {
    // O_NONBLOCK: inspect a FIFO without blocking before the regular-file check.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT') {
      refuse(
        'VAULT_KEY_MISSING: no master key found. For a new or reset vault, run ' +
          '`anchi setup vault init` (source checkout: `./scripts/anchi setup vault init`). ' +
          'Restore the original master key if the VM still contains encrypted credentials.',
      );
    }
    refuse('Key file cannot be opened safely. Check its ownership, permissions and path.');
  }
  try {
    const info = fstatSync(fd);
    if (info.uid !== process.getuid() || info.mode & 0o077 || !info.isFile()) {
      refuse('Key file must be owned by you, regular, and inaccessible to group/others (0600).');
    }
    const master = Buffer.alloc(33);
    const size = readSync(fd, master, 0, 33, 0);
    if (size !== 32) {
      master.fill(0);
      refuse('Invalid master key file.');
    }
    return master.subarray(0, 32);
  } finally {
    closeSync(fd);
  }
}

/** A new random key, only where none exists: a replacement could not decrypt stored accounts. */
function createKey(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const master = randomBytes(32);
  try {
    writeSync(fd, master);
    fsyncSync(fd);
  } finally {
    master.fill(0);
    closeSync(fd);
  }
}

function exists(file) {
  try {
    closeSync(openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

function main(argv) {
  const action = argv[0];
  if (!['init', 'unlock', 'lock', 'status'].includes(action)) {
    refuse('usage: vault.mjs init|unlock|lock|status [--key-file <path>]');
  }
  let keyFile = join(homedir(), '.config/anchi/vault.key');
  if (argv[1] === '--key-file' && argv[2] && argv.length === 3) keyFile = argv[2];
  else if (argv.length !== 1)
    refuse('usage: vault.mjs init|unlock|lock|status [--key-file <path>]');
  if (!/^anchi-vm(-[a-z0-9-]+)?$/.test(VM)) {
    refuse('ANCHI_INSTALL_VM must look like anchi-vm or anchi-vm-<suffix>');
  }
  if (VM === 'anchi-vm' && !IN_GUEST && process.env.ANCHI_VM_MIGRATING !== '1') {
    // Renames a VM created as secure-vm and moves its key here first (scripts/vm-name.sh).
    // A failed migration stops us: the key and the VM may still carry their old names.
    const script = join(dirname(fileURLToPath(import.meta.url)), 'vm-name.sh');
    const migration = spawnSync('bash', [script, 'migrate'], {
      stdio: 'inherit',
      env: { ...process.env, ANCHI_VM_MIGRATING: '1' },
    });
    if (migration.status !== 0) {
      refuse('The move from secure-vm to anchi-vm failed; see the messages above.');
    }
  }
  if (action === 'status' || action === 'lock') {
    console.log(JSON.stringify(remote(action), null, 2));
    return;
  }
  if (action === 'init' && !exists(keyFile)) {
    if (remote('status').encrypted_files) {
      refuse(
        'Encrypted credentials exist. Restore the original master key; do not generate a replacement.',
      );
    }
    createKey(keyFile);
  }
  const master = readKey(keyFile);
  const key = master.toString('base64');
  master.fill(0);
  console.log(JSON.stringify(remote('unlock', { key }), null, 2));
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Refused ? err.message : 'VAULT_OPERATION_FAILED');
  process.exit(1);
}
