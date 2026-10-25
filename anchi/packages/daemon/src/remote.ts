import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { sanitizeLine } from '@anchi/core';
import type { MethodName } from '@anchi/protocol';
import { DaemonClient } from './rpc.ts';
import { openInBrowser } from './services.ts';

/**
 * Where the client's daemon runs: on this computer, or on a remote server (an instabox VM, any SSH
 * host) whose daemon socket `anchi-bridge` joins to the stdio of an SSH session. SSH authenticates
 * the user; the socket stays 0600 and nothing listens on the network.
 */
export type ServerTarget = { kind: 'local' } | RemoteTarget;
export type RemoteTarget = {
  kind: 'remote';
  name: string;
  /** argv up to the remote command */
  ssh: string[];
};

const BOX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SSH_DEST = /^[A-Za-z0-9_][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9.-]*)?$/;

/** `local`, `instabox:<machine>` or `ssh:<[user@]host>`; anything else is refused. */
export function parseServer(text: string | undefined): ServerTarget {
  const value = (text ?? '').trim();
  if (value === '' || value === 'local') return { kind: 'local' };
  const [kind, name = ''] = value.split(/:(.*)/s);
  if (kind === 'instabox' && BOX.test(name)) {
    return { kind: 'remote', name: value, ssh: ['instabox', 'ssh', name, '--'] };
  }
  if (kind === 'ssh' && SSH_DEST.test(name)) {
    return { kind: 'remote', name: value, ssh: ['ssh', '-T', '-o', 'BatchMode=yes', name, '--'] };
  }
  throw new Error(`unknown server "${value}": use local, instabox:<machine> or ssh:<[user@]host>`);
}

/** How a target is written: `local` or the name it was parsed from. */
export function serverName(target: ServerTarget): string {
  return target.kind === 'local' ? 'local' : target.name;
}

/** The server `anchi server` saved in the Anchi home, or undefined. */
export function savedServer(home: string): string | undefined {
  try {
    return readFileSync(join(home, 'server'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveServer(home: string, target: ServerTarget): void {
  writeAtomic(join(home, 'server'), `${serverName(target)}\n`);
}

/** The server a client uses: an explicit choice, else ANCHI_SERVER, else the saved one. */
export function chosenServer(home: string, explicit?: string): ServerTarget {
  return resolveServer(home, explicit ?? process.env.ANCHI_SERVER ?? savedServer(home));
}

/** A remote server saved under a short name. `local` is listed first and never stored. */
export interface SavedServer {
  name: string;
  /** As `serverName` writes it. */
  target: string;
}

/**
 * Lowercase and without `:`, so a name never reads as a target. `local` and the subcommands of
 * `anchi server`, which would shadow a server of that name, are reserved.
 */
const SERVER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const RESERVED_NAMES = new Set(['local', 'ls', 'add', 'rm']);

const serversFile = (home: string) => join(home, 'servers.json');

function savedEntry(name: unknown, target: unknown): SavedServer {
  if (typeof name !== 'string' || !SERVER_NAME.test(name) || RESERVED_NAMES.has(name)) {
    throw new Error(
      `invalid server name ${JSON.stringify(name)}: up to 40 lowercase letters, digits, ".", "_" or "-"; not local, ls, add or rm`,
    );
  }
  const parsed = parseServer(typeof target === 'string' ? target : '');
  if (parsed.kind === 'local') throw new Error('local is always there; save a remote server');
  return { name, target: parsed.name };
}

/** The saved remote servers, without entries that are not valid; undefined if not JSON. */
function readServers(home: string): SavedServer[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(serversFile(home), 'utf8'));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined;
  }
  const entries = (raw as { servers?: unknown } | null)?.servers;
  const servers: SavedServer[] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    let entry: SavedServer;
    try {
      entry = savedEntry((e as SavedServer).name, (e as SavedServer).target);
    } catch {
      continue;
    }
    if (!servers.some((s) => s.name === entry.name || s.target === entry.target)) {
      servers.push(entry);
    }
  }
  return servers;
}

/** The saved servers to change: a file that is not JSON is the user's to fix, not to overwrite. */
function writableServers(home: string): SavedServer[] {
  const servers = readServers(home);
  if (!servers) throw new Error(`${serversFile(home)} is not valid JSON: fix or remove it`);
  return servers;
}

function writeServers(home: string, servers: SavedServer[]) {
  writeAtomic(serversFile(home), `${JSON.stringify({ servers }, null, 2)}\n`);
}

/** Replaces a file of the Anchi home as a whole: a reader sees the old text or the new one. */
function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** `local` first, then the saved remote servers in the order they were added. */
export function listServers(home: string): SavedServer[] {
  return [{ name: 'local', target: 'local' }, ...(readServers(home) ?? [])];
}

/** Saves a remote server under `name`; a name or a target already saved is refused. */
export function addServer(home: string, name: string, target: string): SavedServer {
  const servers = writableServers(home);
  const added = savedEntry(name, target);
  const same = servers.find((s) => s.name === added.name || s.target === added.target);
  if (same?.name === added.name) throw new Error(`a server named ${added.name} is already saved`);
  if (same) throw new Error(`${added.target} is already saved as ${same.name}`);
  writeServers(home, [...servers, added]);
  return added;
}

/** Forgets a saved server; when it was the one in use, `local` is from now on. */
export function removeServer(home: string, name: string): SavedServer {
  if (name === 'local') throw new Error('local is always there and cannot be removed');
  const servers = writableServers(home);
  const gone = servers.find((s) => s.name === name);
  if (!gone) throw new Error(`no saved server named ${JSON.stringify(name)}`);
  writeServers(
    home,
    servers.filter((s) => s !== gone),
  );
  if (savedServer(home) === gone.target) saveServer(home, { kind: 'local' });
  return gone;
}

/** A saved server's name, or a target as `parseServer` reads it. */
export function resolveServer(home: string, text: string | undefined): ServerTarget {
  const value = (text ?? '').trim();
  if (!SERVER_NAME.test(value) || value === 'local') return parseServer(value);
  const saved = readServers(home)?.find((s) => s.name === value);
  if (!saved)
    throw new Error(`unknown server ${JSON.stringify(value)}: no saved server has that name`);
  return parseServer(saved.target);
}

const LOGIN_METHODS: MethodName[] = [
  'services.googleLogin',
  'services.xLogin',
  'services.redditLogin',
];

/** The loopback callback port a sign-in URL sends the browser back to, or undefined. */
export function callbackPort(url: string): number | undefined {
  try {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
    const port = Number(redirect.port);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1') return undefined;
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Why a remote daemon was not reached: the SSH client's exit status, no client, or no answer. */
type RemoteFailure = number | 'spawn' | 'timeout';

class RemoteError extends Error {
  constructor(
    message: string,
    readonly reason: RemoteFailure,
  ) {
    super(message);
  }
}

/** One SSH session running `anchi-bridge` with `args`, as a stream; its stderr goes to `onError`. */
function bridge(
  target: RemoteTarget,
  args: string[],
  onError: (text: string, reason: RemoteFailure) => void,
) {
  const [cmd, ...rest] = target.ssh;
  const child = spawn(cmd!, [...rest, 'anchi-bridge', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString('utf8')).slice(-2000);
  });
  const stream = new Duplex({
    read: () => child.stdout.resume(),
    // A write the host never reads fails with EPIPE; the host's close reports why, not the write.
    write: (chunk, _encoding, done) => child.stdin.write(chunk, () => done()),
    final: (done) => child.stdin.end(done),
  });
  child.stdout.on('data', (b: Buffer) => {
    if (!stream.push(b)) child.stdout.pause();
  });
  child.stdout.on('end', () => stream.push(null));
  // A host that exits at once (no anchi-bridge, ssh refused) can close its input before the first
  // request is written; its close, which follows, ends the stream with the reason.
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    onError(`${cmd}: ${err.message}`, 'spawn');
    stream.destroy();
  });
  child.on('close', (code) => {
    if (code) onError(stderr.trim() || `${cmd} exited with ${code}`, code);
    stream.destroy();
  });
  return { child, stream };
}

/**
 * Relays the browser's sign-in callback from this computer's 127.0.0.1:`port` to the same port on
 * the server, where the daemon waits for it, until the daemon's own sign-in timeout has passed.
 */
function relayCallback(target: RemoteTarget, port: number): Promise<Server> {
  const server = createServer((socket) => {
    const { stream } = bridge(target, ['tcp', String(port)], () => socket.destroy());
    socket.pipe(stream).pipe(socket);
    socket.on('error', () => stream.destroy());
    stream.on('error', () => socket.destroy());
  });
  setTimeout(() => server.close(), 600_000).unref();
  return new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(new Error('OAUTH_CALLBACK_PORT_UNAVAILABLE on this computer')),
    );
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Connects to a remote server's daemon. Sign-in URLs it returns are opened here, with the callback
 * relayed back to the server: its own browser is not the user's.
 */
export async function connectRemote(
  target: RemoteTarget,
  openUrl: (url: string) => void = openInBrowser,
  timeoutMs = 60_000,
): Promise<DaemonClient> {
  let failed: (err: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => (failed = reject));
  // A bridge that ends after the connection was made only closes the client.
  failure.catch(() => {});
  const { child, stream } = bridge(target, [], (text, reason) =>
    failed(new RemoteError(`cannot reach the Anchi daemon on ${target.name}: ${text}`, reason)),
  );
  const relays = new Map<number, Server>();
  const client = DaemonClient.over(stream, async (method, result) => {
    const url = (result as { url?: unknown } | null)?.url;
    if (!LOGIN_METHODS.includes(method) || typeof url !== 'string') return;
    const port = callbackPort(url);
    if (port !== undefined && !relays.has(port)) {
      const relay = await relayCallback(target, port);
      relays.set(port, relay);
      relay.on('close', () => relays.delete(port));
    }
    openUrl(url);
  });
  client.onClose(() => {
    for (const relay of relays.values()) relay.close();
    child.kill();
  });
  const timer = setTimeout(
    () =>
      failed(
        new RemoteError(
          `no answer from the Anchi daemon on ${target.name} within ${timeoutMs / 1000}s`,
          'timeout',
        ),
      ),
    timeoutMs,
  );
  try {
    await Promise.race([client.call('daemon.status'), failure]);
  } catch (err) {
    child.kill();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return client;
}

/** What stands between this computer and a remote server's daemon. */
export type ProbeResult =
  | { kind: 'ok' }
  /** The host answers but has no `anchi-bridge`; `hint` is the command that installs it. */
  | { kind: 'bridge-missing'; detail: string; hint: string }
  /** SSH could not log in, or nothing answered in time. */
  | { kind: 'unreachable'; detail: string }
  | { kind: 'error'; detail: string };

/**
 * Connects once to a remote server's daemon and closes again. A remote shell exits 127 for a
 * command it cannot find and ssh exits 255 for its own errors; `detail` is the server's text,
 * on one line.
 */
export async function probeServer(target: RemoteTarget, timeoutMs = 15_000): Promise<ProbeResult> {
  try {
    (await connectRemote(target, () => {}, timeoutMs)).close();
    return { kind: 'ok' };
  } catch (err) {
    const detail = sanitizeLine((err as Error).message).slice(0, 500);
    const reason = err instanceof RemoteError ? err.reason : undefined;
    if (reason === 255 || reason === 'timeout') return { kind: 'unreachable', detail };
    if (reason === 127 || /anchi-bridge: (command )?not found/.test(detail)) {
      return { kind: 'bridge-missing', detail, hint: `scripts/remote.sh ${target.name}` };
    }
    return { kind: 'error', detail };
  }
}
