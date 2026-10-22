import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { Duplex } from 'node:stream';
import type { MethodName } from '@anchi/protocol';
import { DaemonClient } from './rpc.ts';
import { openInBrowser } from './services.ts';

/**
 * Where the client's daemon runs: on this computer, or on a remote server (an instabox VM, any SSH
 * host) whose daemon socket `anchi-bridge` joins to the stdio of an SSH session. SSH authenticates
 * the user; the socket stays 0600 and nothing listens on the network.
 */
export type ServerTarget =
  | { kind: 'local' }
  | { kind: 'remote'; name: string; /** argv up to the remote command */ ssh: string[] };

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

/** One SSH session running `anchi-bridge` with `args`, as a stream; its stderr goes to `onError`. */
function bridge(
  target: Extract<ServerTarget, { kind: 'remote' }>,
  args: string[],
  onError: (text: string) => void,
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
    write: (chunk, _encoding, done) => child.stdin.write(chunk, done),
    final: (done) => child.stdin.end(done),
  });
  child.stdout.on('data', (b: Buffer) => {
    if (!stream.push(b)) child.stdout.pause();
  });
  child.stdout.on('end', () => stream.push(null));
  child.stdin.on('error', () => stream.destroy());
  child.on('error', (err) => {
    onError(`${cmd}: ${err.message}`);
    stream.destroy();
  });
  child.on('close', (code) => {
    if (code) onError(stderr.trim() || `${cmd} exited with ${code}`);
    stream.destroy();
  });
  return { child, stream };
}

/**
 * Relays the browser's sign-in callback from this computer's 127.0.0.1:`port` to the same port on
 * the server, where the daemon waits for it, until the daemon's own sign-in timeout has passed.
 */
function relayCallback(
  target: Extract<ServerTarget, { kind: 'remote' }>,
  port: number,
): Promise<Server> {
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
  target: Extract<ServerTarget, { kind: 'remote' }>,
  openUrl: (url: string) => void = openInBrowser,
  timeoutMs = 60_000,
): Promise<DaemonClient> {
  let failed: (err: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => (failed = reject));
  // A bridge that ends after the connection was made only closes the client.
  failure.catch(() => {});
  const { child, stream } = bridge(target, [], (text) =>
    failed(new Error(`cannot reach the Anchi daemon on ${target.name}: ${text}`)),
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
        new Error(`no answer from the Anchi daemon on ${target.name} within ${timeoutMs / 1000}s`),
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
