// Keep the master key out of the guest's services and out of the long-running daemon: this short
// process reads it and sends it on stdin to vault administration, which keeps it in memory only.
// On a remote server (ANCHI_GUEST=local) that is guest-root vault_admin.py through sudo, and the
// key stays in the login user's home, which neither task cells nor trusted services read. On the
// host placement (ANCHI_GUEST=host, the default) it is the host services process, on this
// computer, as the user (anchi/packages/daemon/src/host-placement.ts).
// The daemon runs it with its own Node under `ulimit -c 0` (anchi/packages/daemon/src/host.ts).
//   node scripts/vault.mjs init|unlock|lock|status [--key-file <path>]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUEST = process.env.ANCHI_GUEST ?? 'host';
const IN_GUEST = GUEST === 'local';
const ANCHI_HOME = process.env.ANCHI_HOME ?? join(homedir(), '.anchi');

class Refused extends Error {}

function refuse(message) {
  throw new Refused(message);
}

/** The host services' CLI: the release bundle beside this script's lib/, else the sources on tsx. */
function hostCli() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = join(root, 'lib/host-vault.mjs');
  if (existsSync(bundled)) return [process.execPath, bundled];
  const tsx = createRequire(join(root, 'anchi/package.json')).resolve('tsx');
  return [process.execPath, '--import', tsx, join(root, 'anchi/packages/host-services/src/cli.ts')];
}

function remote(action, value) {
  const input = value === undefined ? '' : JSON.stringify(value);
  const [bin, ...args] = IN_GUEST
    ? ['sudo', '-n', '/usr/bin/python3', '/opt/secure-vm/services/vault_admin.py', action]
    : [...hostCli(), '--root', join(ANCHI_HOME, 'host'), 'vault', action];
  const result = spawnSync(bin, args, { input, encoding: 'utf8' });
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
          'Restore the original master key if the vault still contains encrypted credentials.',
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
  if (!IN_GUEST && GUEST !== 'host') refuse(`ANCHI_GUEST must be local or host, not ${GUEST}`);
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
