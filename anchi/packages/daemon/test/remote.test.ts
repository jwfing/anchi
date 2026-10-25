import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/host.ts';
import {
  addServer,
  callbackPort,
  connectRemote,
  listServers,
  parseServer,
  probeServer,
  type RemoteTarget,
  removeServer,
  resolveServer,
  savedServer,
  saveServer,
  type ServerTarget,
} from '../src/remote.ts';
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

const anchiHome = () => mkdtempSync(join(tmpdir(), 'anchi-servers-'));
const serversJson = (home: string) => join(home, 'servers.json');

describe('saved servers', () => {
  it('lists local first, then the servers added, in a 0600 file written whole', () => {
    const home = anchiHome();
    expect(listServers(home)).toEqual([{ name: 'local', target: 'local' }]);
    expect(addServer(home, 'rnotes-box', ' ssh:dev@box.example.com ')).toEqual({
      name: 'rnotes-box',
      target: 'ssh:dev@box.example.com',
    });
    addServer(home, 'cloud', 'instabox:anchi-server');
    expect(listServers(home)).toEqual([
      { name: 'local', target: 'local' },
      { name: 'rnotes-box', target: 'ssh:dev@box.example.com' },
      { name: 'cloud', target: 'instabox:anchi-server' },
    ]);
    expect(JSON.parse(readFileSync(serversJson(home), 'utf8')).servers).toHaveLength(2);
    expect(statSync(serversJson(home)).mode & 0o777).toBe(0o600);
    expect(readdirSync(home)).toEqual(['servers.json']);
  });

  it('refuses targets SSH would read as options, and local, empty or taken names', () => {
    const home = anchiHome();
    addServer(home, 'box', 'ssh:dev@box');
    const refused: [string, string][] = [
      ['evil', 'ssh:-oProxyCommand=x'],
      ['evil', 'instabox:-oProxyCommand=x'],
      ['evil', 'remote:box'],
      ['evil', 'local'],
      ['evil', ''],
      ['', 'ssh:dev@other'],
      ['local', 'ssh:dev@other'],
      ['ls', 'ssh:dev@other'],
      ['Box2', 'ssh:dev@other'],
      ['a:b', 'ssh:dev@other'],
      ['a b', 'ssh:dev@other'],
      ['bad\u001b[2J', 'ssh:dev@other'],
      ['-x', 'ssh:dev@other'],
      ['x'.repeat(41), 'ssh:dev@other'],
      ['box', 'ssh:dev@other'],
      ['other', 'ssh:dev@box'],
    ];
    for (const [name, target] of refused) {
      expect(() => addServer(home, name, target), `${name} ${target}`).toThrow();
    }
    expect(listServers(home)).toEqual([
      { name: 'local', target: 'local' },
      { name: 'box', target: 'ssh:dev@box' },
    ]);
  });

  it('skips entries of the file that are not valid servers', () => {
    const home = anchiHome();
    writeFileSync(
      serversJson(home),
      JSON.stringify({
        servers: [
          { name: 'good', target: 'ssh:dev@good' },
          { name: 'evil', target: 'ssh:-oProxyCommand=x' },
          { name: 'Bad Name', target: 'instabox:a' },
          { name: 'local', target: 'ssh:dev@x' },
          { name: 'nolocal', target: 'local' },
          { name: 'notarget' },
          { name: 'good', target: 'ssh:dev@again' },
          null,
          'ssh:dev@string',
          42,
        ],
      }),
    );
    expect(listServers(home)).toEqual([
      { name: 'local', target: 'local' },
      { name: 'good', target: 'ssh:dev@good' },
    ]);
    expect(() => resolveServer(home, 'evil')).toThrow(/no saved server/);
  });

  it('lists only local from a file that is not JSON, and never overwrites it', () => {
    const home = anchiHome();
    writeFileSync(serversJson(home), '{"servers": [');
    expect(listServers(home)).toEqual([{ name: 'local', target: 'local' }]);
    expect(() => addServer(home, 'box', 'ssh:dev@box')).toThrow(/not valid JSON/);
    expect(readFileSync(serversJson(home), 'utf8')).toBe('{"servers": [');
  });

  it('selects a saved name or a raw target, and refuses an unknown name', () => {
    const home = anchiHome();
    addServer(home, 'box', 'instabox:anchi-server');
    expect(resolveServer(home, 'box')).toEqual(parseServer('instabox:anchi-server'));
    expect(resolveServer(home, 'ssh:dev@elsewhere')).toEqual(parseServer('ssh:dev@elsewhere'));
    expect(resolveServer(home, 'local')).toEqual({ kind: 'local' });
    expect(resolveServer(home, undefined)).toEqual({ kind: 'local' });
    expect(() => resolveServer(home, 'nobox')).toThrow(/no saved server/);
    expect(() => resolveServer(home, 'ssh:-oProxyCommand=x')).toThrow(/unknown server/);
  });

  it('falls back to local when the server in use is removed, and never removes local', () => {
    const home = anchiHome();
    addServer(home, 'box', 'ssh:dev@box');
    addServer(home, 'other', 'ssh:dev@other');
    saveServer(home, resolveServer(home, 'box'));
    expect(savedServer(home)).toBe('ssh:dev@box');

    removeServer(home, 'other');
    expect(savedServer(home)).toBe('ssh:dev@box');
    expect(removeServer(home, 'box')).toEqual({ name: 'box', target: 'ssh:dev@box' });
    expect(savedServer(home)).toBe('local');
    expect(listServers(home)).toEqual([{ name: 'local', target: 'local' }]);

    expect(() => removeServer(home, 'local')).toThrow(/cannot be removed/);
    expect(() => removeServer(home, 'box')).toThrow(/no saved server/);
  });

  it('leaves no temporary file when the server choice cannot be written', () => {
    const home = anchiHome();
    mkdirSync(join(home, 'server', 'occupied'), { recursive: true });
    expect(() => saveServer(home, { kind: 'local' })).toThrow();
    expect(readdirSync(home)).toEqual(['server']);
  });
});

/** A stand-in for `ssh` that runs `script` instead of reaching a host. */
function sshRunning(script: string): RemoteTarget {
  const dir = mkdtempSync(join(tmpdir(), 'anchi-probe-'));
  const ssh = join(dir, 'fake-ssh');
  writeFileSync(ssh, `#!/bin/sh\n${script}\n`);
  chmodSync(ssh, 0o755);
  return { kind: 'remote', name: 'ssh:dev@box', ssh: [ssh] };
}

describe('probeServer', () => {
  it('says ok when the daemon answers through the bridge', async () => {
    const home = mkdtempSync(join('/tmp', 'ar-'));
    fakeDaemon(home, 'https://example.com');
    expect(await probeServer(fakeServer(home))).toEqual({ kind: 'ok' });
  });

  it('names the setup command when the host has no anchi-bridge', async () => {
    for (const script of [
      `echo 'zsh:1: command not found: anchi-bridge' >&2; exit 127`,
      `echo 'bash: line 1: anchi-bridge: command not found' >&2; exit 1`,
    ]) {
      expect(await probeServer(sshRunning(script)), script).toMatchObject({
        kind: 'bridge-missing',
        hint: 'scripts/remote.sh ssh:dev@box',
      });
    }
  });

  it('gives the reason every time a host exits before reading the request', async () => {
    // On Linux the first write can fail with EPIPE before the exit is seen, a few times in a hundred.
    const host = sshRunning(`echo 'bash: line 1: anchi-bridge: command not found' >&2; exit 1`);
    const kinds = new Set<string>();
    for (let i = 0; i < 40; i++) kinds.add((await probeServer(host)).kind);
    expect([...kinds]).toEqual(['bridge-missing']);
  });

  it('says unreachable when ssh fails or nothing answers in time', async () => {
    expect(
      await probeServer(
        sshRunning(`echo 'ssh: connect to host box port 22: Connection refused' >&2; exit 255`),
      ),
    ).toEqual({
      kind: 'unreachable',
      detail:
        'cannot reach the Anchi daemon on ssh:dev@box: ssh: connect to host box port 22: Connection refused',
    });
    expect(await probeServer(sshRunning('exec sleep 30'), 200)).toMatchObject({
      kind: 'unreachable',
    });
  });

  it('reports any other failure on one bounded line without terminal controls', async () => {
    const probe = await probeServer(
      sshRunning(`printf '\\033[2Jline one\\nline two %01000d\\n' 0 >&2; exit 1`),
    );
    expect(probe.kind).toBe('error');
    const detail = (probe as { detail: string }).detail;
    expect(detail).toMatch(/^cannot reach the Anchi daemon on ssh:dev@box: line one line two 0+$/);
    expect(detail.length).toBeLessThanOrEqual(500);

    const missing = await probeServer({ kind: 'remote', name: 'x', ssh: ['/nonexistent/ssh'] });
    expect(missing.kind).toBe('error');
  });
});
