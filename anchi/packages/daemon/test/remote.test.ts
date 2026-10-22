import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/host.ts';
import { callbackPort, connectRemote, parseServer, type ServerTarget } from '../src/remote.ts';
import { Peer } from '../src/rpc.ts';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

/**
 * An `ssh` stand-in that runs the real anchi-bridge here with ANCHI_HOME=<home>. The server's
 * loopback is this computer's too, so a callback for port P is served at P+1 on the "server".
 */
function fakeServer(home: string): Extract<ServerTarget, { kind: 'remote' }> {
  const ssh = join(home, 'fake-ssh');
  writeFileSync(
    ssh,
    `#!/bin/sh
[ "$1" = anchi-bridge ] || exit 64
shift
if [ "$1" = tcp ]; then set -- tcp $(($2 + 1)); fi
ANCHI_HOME='${home}' exec python3 '${join(REPO_ROOT, 'scripts/anchi-bridge.py')}' "$@"
`,
  );
  chmodSync(ssh, 0o755);
  return { kind: 'remote', name: 'test', ssh: [ssh] };
}

/** A daemon socket answering `daemon.status` and an X sign-in with `url`. */
function fakeDaemon(home: string, url: string): Server {
  mkdirSync(join(home, 'run'), { recursive: true });
  const server = createServer((socket) => {
    new Peer(socket, async (method) => {
      if (method === 'daemon.status') return { pid: 1 };
      if (method === 'services.xLogin') return { url };
      throw new Error('unexpected');
    });
  });
  server.listen(join(home, 'run', 'daemon.sock'));
  cleanup.push(() => server.close());
  return server;
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe('parseServer', () => {
  it('names the local daemon, an instabox machine or an SSH host', () => {
    expect(parseServer(undefined)).toEqual({ kind: 'local' });
    expect(parseServer('local')).toEqual({ kind: 'local' });
    expect(parseServer('instabox:anchi-server')).toEqual({
      kind: 'remote',
      name: 'instabox:anchi-server',
      ssh: ['instabox', 'ssh', 'anchi-server', '--'],
    });
    expect(parseServer('ssh:dev@box.example.com').kind).toBe('remote');
  });

  it('refuses names SSH would read as options or that carry anything else', () => {
    for (const bad of [
      'instabox:-oProxyCommand=sh',
      'ssh:-oProxyCommand=sh',
      'ssh:dev@-x',
      'instabox:a b',
      'instabox:',
      'remote:box',
      'ssh:host;rm',
    ]) {
      expect(() => parseServer(bad), bad).toThrow(/unknown server/);
    }
  });
});

describe('callbackPort', () => {
  it('follows only a loopback http callback on an unprivileged port', () => {
    const url = (redirect: string) =>
      `https://x.com/i/oauth2/authorize?redirect_uri=${encodeURIComponent(redirect)}&state=s`;
    expect(callbackPort(url('http://127.0.0.1:48173/callback'))).toBe(48173);
    expect(callbackPort(url('http://localhost:48173/callback'))).toBeUndefined();
    expect(callbackPort(url('http://0.0.0.0:48173/callback'))).toBeUndefined();
    expect(callbackPort(url('https://127.0.0.1:48173/callback'))).toBeUndefined();
    expect(callbackPort(url('http://127.0.0.1:22/callback'))).toBeUndefined();
    expect(callbackPort('not a url')).toBeUndefined();
  });
});

describe('connectRemote', () => {
  it('reaches the daemon through the bridge and relays a sign-in callback to the server', async () => {
    const home = mkdtempSync(join('/tmp', 'ar-'));
    const port = await freePort();
    // The daemon's sign-in listener on the "server".
    const callback = createHttpServer((req, res) => res.end(`got ${req.url}`));
    await new Promise<void>((r) => callback.listen(port + 1, '127.0.0.1', r));
    cleanup.push(() => callback.close());
    const signIn = `https://x.com/i/oauth2/authorize?redirect_uri=${encodeURIComponent(
      `http://127.0.0.1:${port}/callback`,
    )}`;
    fakeDaemon(home, signIn);
    const opened: string[] = [];
    const client = await connectRemote(fakeServer(home), (u) => opened.push(u));
    cleanup.push(() => client.close());

    expect(await client.call('services.xLogin')).toEqual({ url: signIn });
    expect(opened).toEqual([signIn]);
    // The browser on this computer comes back to 127.0.0.1:<port>; the server answers.
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=c&state=s`);
    expect(await res.text()).toBe('got /callback?code=c&state=s');
  });

  it('says the daemon is not running instead of hanging when the server has no socket', async () => {
    const home = mkdtempSync(join('/tmp', 'ar-'));
    await expect(connectRemote(fakeServer(home), () => {}, 10_000)).rejects.toThrow(
      /cannot reach the Anchi daemon on test: anchi-bridge: the Anchi daemon is not running/,
    );
  });
});
