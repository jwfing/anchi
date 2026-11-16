import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialStore } from '../src/credentials/store.ts';
import { Approvals } from '../src/proxy/approvals.ts';
import { Audit } from '../src/proxy/audit.ts';
import { CertificateAuthority } from '../src/proxy/ca.ts';
import { HostProxy } from '../src/proxy/proxy.ts';
import { Vault } from '../src/vault/store.ts';

const TOKEN = `ghp_${'t'.repeat(36)}`;
const root = mkdtempSync(join(tmpdir(), 'anchi-proxy-'));

/** Every request the fake upstreams saw: method, path, headers and body. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
const seen: Seen[] = [];

function echo(req: IncomingMessage, res: import('node:http').ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k] = Array.isArray(v) ? v.join(',') : String(v);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers,
      body: Buffer.concat(chunks).toString('latin1'),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'echo' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
}

let upstreamTls: Server;
let upstreamPlain: Server;
let upstreamCa: string;
let proxy: HostProxy;
let approvals: Approvals;
let ca: CertificateAuthority;
let audit: Audit;
let proxyPort: number;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
  );
}

function auditRows(): Record<string, unknown>[] {
  try {
    return readFileSync(audit.file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** A CONNECT through the proxy, then TLS to `host` over it, then one HTTP/1.1 request. */
function viaProxy(options: {
  host: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  chunked?: boolean;
  trust: string;
  raw?: boolean;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  connectStatus: number;
}> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1');
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(`CONNECT ${options.host}:443 HTTP/1.1\r\nHost: ${options.host}:443\r\n\r\n`),
    );
    let head = '';
    const onConnect = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onConnect);
      const status = Number(head.split(' ')[1]);
      const rest = Buffer.from(head.slice(end + 4), 'latin1');
      if (status !== 200) {
        const bodyChunks: Buffer[] = [rest];
        socket.on('data', (c: Buffer) => bodyChunks.push(c));
        socket.on('close', () =>
          resolve({ status, headers: {}, body: Buffer.concat(bodyChunks), connectStatus: status }),
        );
        return;
      }
      if (rest.length) socket.unshift(new Uint8Array(rest));
      const tls = tlsConnect({ socket, servername: options.host, ca: options.trust }, () => {
        const method = options.method ?? 'GET';
        const headers = { host: options.host, ...(options.headers ?? {}) };
        const body = options.body ?? Buffer.alloc(0);
        const lines = [
          `${method} ${options.path} HTTP/1.1`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ];
        if (options.chunked) lines.push('transfer-encoding: chunked');
        else if (body.length || method === 'POST' || method === 'PUT')
          lines.push(`content-length: ${body.length}`);
        lines.push('connection: close');
        tls.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (options.chunked) {
          tls.write(`${body.length.toString(16)}\r\n`);
          tls.write(body);
          tls.write('\r\n0\r\n\r\n');
        } else tls.write(body);
      });
      tls.on('error', reject);
      const chunks: Buffer[] = [];
      tls.on('data', (c: Buffer) => chunks.push(c));
      tls.on('close', () => {
        const text = Buffer.concat(chunks);
        const split = text.indexOf('\r\n\r\n');
        const headText = text.subarray(0, split).toString('latin1');
        const [statusLine, ...headerLines] = headText.split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of headerLines) {
          const i = line.indexOf(':');
          headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
        }
        let body = text.subarray(split + 4);
        if (headers['transfer-encoding'] === 'chunked') {
          const parts: Buffer[] = [];
          let pos = 0;
          for (;;) {
            const lineEnd = body.indexOf('\r\n', pos);
            const size = parseInt(body.subarray(pos, lineEnd).toString(), 16);
            if (!size) break;
            parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
            pos = lineEnd + 2 + size + 2;
          }
          body = Buffer.concat(parts);
        }
        resolve({ status: Number(statusLine!.split(' ')[1]), headers, body, connectStatus: 200 });
      });
    };
    socket.on('data', onConnect);
  });
}

beforeAll(async () => {
  // A self-signed upstream, trusted by the proxy through the test seam only.
  const dir = mkdtempSync(join(tmpdir(), 'anchi-upstream-'));
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
    '-days',
    '2',
    '-subj',
    '/CN=upstream',
    '-addext',
    'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:example.com,DNS:api.linear.app',
  ]);
  upstreamCa = readFileSync(join(dir, 'cert.pem'), 'utf8');
  upstreamTls = createHttpsServer(
    { key: readFileSync(join(dir, 'key.pem')), cert: upstreamCa },
    echo,
  );
  upstreamPlain = createHttpServer(echo);
  const tlsPort = await listen(upstreamTls);
  const plainPort = await listen(upstreamPlain);
  const vault = new Vault(join(root, 'auth'));
  vault.unlock(Buffer.alloc(32, 'k').toString('base64'));
  const credentials = new CredentialStore(vault);
  credentials.importToken('github', TOKEN);
  approvals = new Approvals(60);
  audit = new Audit(join(root, 'audit.jsonl'));
  ca = new CertificateAuthority(join(root, 'ca'));
  await ca.ensure();
  proxy = new HostProxy({
    ca,
    audit,
    approvals,
    credentials,
    settings: () => ({ high_risk_disabled: [], approval_timeout_s: 60 }),
    log: () => {},
    network: {
      resolve: async (host) =>
        host === 'private.example'
          ? { address: null, reason: 'non-public destination 10.0.0.1' }
          : { address: '127.0.0.1', reason: null },
      port: (_host, port) => (port === 443 ? tlsPort : port === 80 ? plainPort : port),
      ca: upstreamCa,
    },
  });
  const free = createHttpServer();
  proxyPort = await listen(free);
  await new Promise<void>((r) => free.close(() => r()));
  await proxy.register({
    connectors: ['github'],
    ask: [],
    high_risk_disabled: [],
    egress: null,
    listen_port: proxyPort,
  });
}, 60_000);

afterAll(async () => {
  await proxy.stop();
  upstreamTls.close();
  upstreamPlain.close();
});

describe('host proxy', () => {
  it('terminates a granted host, injects the credential and audits the request', async () => {
    seen.length = 0;
    const r = await viaProxy({
      host: 'api.github.com',
      path: '/user',
      headers: {
        authorization: 'token anchi-placeholder',
        'proxy-authorization': 'Basic x',
        accept: 'application/json',
      },
      trust: ca.certificate(),
    });
    expect([r.status, r.headers['x-upstream']]).toEqual([200, 'echo']);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.headers['proxy-authorization']).toBeUndefined();
    expect(seen[0]!.headers.host).toBe('api.github.com');
    const row = auditRows().findLast((x) => x.path === '/user')!;
    expect(row).toMatchObject({
      task: 'host',
      agent: 'host',
      method: 'GET',
      host: 'api.github.com',
      rule: 'github-api',
      decision: 'inject',
      client_cred: 'placeholder',
    });
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });

  it('passes an unrelated host as an opaque tunnel, bytes untouched', async () => {
    seen.length = 0;
    const r = await viaProxy({
      host: 'example.com',
      path: '/x',
      headers: { authorization: 'Bearer my-own' },
      trust: upstreamCa,
    });
    expect(r.status).toBe(200);
    expect(seen[0]!.headers.authorization).toBe('Bearer my-own');
    expect(auditRows().findLast((x) => x.event === 'tunnel')).toMatchObject({
      host: 'example.com',
      decision: 'pass',
    });
    // Through the proxy's own CA the client would see the upstream, not the proxy: no termination.
    await expect(
      viaProxy({ host: 'example.com', path: '/x', trust: ca.certificate() }),
    ).rejects.toThrow();
  });

  it('refuses a private destination and a Host header naming another host', async () => {
    const blocked = await viaProxy({ host: 'private.example', path: '/', trust: upstreamCa });
    expect(blocked.connectStatus).toBe(502);
    expect(blocked.body.toString()).toContain('non-public');
    const mismatch = await viaProxy({
      host: 'api.github.com',
      path: '/user',
      headers: { host: 'evil.example' },
      trust: ca.certificate(),
    });
    expect(mismatch.status).toBe(400);
    expect(auditRows().findLast((x) => x.decision === 'host-mismatch')).toBeTruthy();
  });

  it('answers a denied endpoint itself and holds writes the session asks about', async () => {
    seen.length = 0;
    const denied = await viaProxy({
      host: 'api.github.com',
      method: 'POST',
      path: '/user/keys',
      body: Buffer.from('{}'),
      trust: ca.certificate(),
    });
    expect([denied.status, denied.body.toString()]).toEqual([
      403,
      'anchi: POST /user/keys denied\n',
    ]);
    expect(seen.length).toBe(0);
    await proxy.register({
      connectors: ['github'],
      ask: ['github'],
      high_risk_disabled: [],
      egress: null,
      listen_port: proxyPort,
    });
    const held = viaProxy({
      host: 'api.github.com',
      method: 'POST',
      path: '/repos/o/r/issues',
      body: Buffer.from('{"title":"x"}'),
      trust: ca.certificate(),
    });
    await new Promise((r) => setTimeout(r, 200));
    const [pending] = [...approvals.pending.values()];
    expect(pending!.item).toMatchObject({
      task: 'host',
      connector: 'github',
      operation: 'POST /repos/o/r/issues',
      reason: 'approvals: github asks',
    });
    expect(pending!.item.summary).toBe('POST /repos/o/r/issues\n{"title":"x"}');
    approvals.decide(pending!.item.id, false);
    const refused = await held;
    expect([refused.status, refused.body.toString()]).toEqual([
      403,
      'anchi: approval for this write was denied\n',
    ]);
    expect(seen.length).toBe(0);
    const allowed = viaProxy({
      host: 'api.github.com',
      method: 'POST',
      path: '/repos/o/r/issues',
      body: Buffer.from('{"title":"y"}'),
      trust: ca.certificate(),
    });
    await new Promise((r) => setTimeout(r, 200));
    approvals.decide([...approvals.pending.keys()][0]!, true);
    expect((await allowed).status).toBe(200);
    expect(seen[0]!.body).toBe('{"title":"y"}');
    expect(auditRows().findLast((x) => x.path === '/repos/o/r/issues')).toMatchObject({
      approval: 'approved',
      decision: 'inject',
    });
    await proxy.register({
      connectors: ['github'],
      ask: [],
      high_risk_disabled: [],
      egress: null,
      listen_port: proxyPort,
    });
  });

  it('holds high-risk operations whatever the approvals, and reads are never held', async () => {
    seen.length = 0;
    const merge = viaProxy({
      host: 'api.github.com',
      method: 'PUT',
      path: '/repos/o/r/pulls/7/merge',
      body: Buffer.alloc(0),
      trust: ca.certificate(),
    });
    await new Promise((r) => setTimeout(r, 200));
    const [pending] = [...approvals.pending.values()];
    expect(pending!.item.reason).toBe('high-risk: merge a pull request');
    approvals.decide(pending!.item.id, false);
    expect((await merge).status).toBe(403);
    expect(auditRows().findLast((x) => x.path === '/repos/o/r/pulls/7/merge')).toMatchObject({
      risk: 'github-merge',
      decision: 'held-denied',
    });
    const read = await viaProxy({
      host: 'api.github.com',
      path: '/repos/o/r/pulls',
      trust: ca.certificate(),
    });
    expect(read.status).toBe(200);
  });

  it('keeps the egress list for tunnels and terminated hosts alike', async () => {
    await proxy.register({
      connectors: ['github'],
      ask: [],
      high_risk_disabled: [],
      egress: ['api.github.com'],
      listen_port: proxyPort,
    });
    const refused = await viaProxy({ host: 'example.com', path: '/', trust: upstreamCa });
    expect([refused.connectStatus, refused.body.toString()]).toEqual([
      403,
      'anchi: example.com is not in the egress list\n',
    ]);
    expect(
      (await viaProxy({ host: 'api.github.com', path: '/user', trust: ca.certificate() })).status,
    ).toBe(200);
    await proxy.register({
      connectors: ['github'],
      ask: [],
      high_risk_disabled: [],
      egress: null,
      listen_port: proxyPort,
    });
  });

  it('streams a chunked push once its ref updates pass, and rejects a push to main', async () => {
    seen.length = 0;
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    const push = (ref: string) =>
      Buffer.from(
        `${pkt(`${'2'.repeat(40)} ${'1'.repeat(40)} ${ref}\0report-status side-band-64k\n`)}0000PACK\0\0\0\u0002${'x'.repeat(500)}`,
        'latin1',
      );
    const ok = await viaProxy({
      host: 'github.com',
      method: 'POST',
      path: '/o/r.git/git-receive-pack',
      body: push('refs/heads/fix'),
      chunked: true,
      trust: ca.certificate(),
    });
    expect(ok.status).toBe(200);
    expect(seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );
    expect(seen[0]!.body.length).toBe(push('refs/heads/fix').length);
    expect(auditRows().findLast((x) => x.event === 'push')).toMatchObject({
      decision: 'inject',
      op: 'git push: update refs/heads/fix',
    });
    seen.length = 0;
    const rejected = await viaProxy({
      host: 'github.com',
      method: 'POST',
      path: '/o/r.git/git-receive-pack',
      body: push('refs/heads/main'),
      chunked: true,
      trust: ca.certificate(),
    });
    expect(rejected.status).toBe(200);
    expect(rejected.headers['content-type']).toBe('application/x-git-receive-pack-result');
    expect(rejected.body.toString('latin1')).toContain(
      'ng refs/heads/main anchi: push to main or master',
    );
    expect(seen.length).toBe(0);
    expect(auditRows().findLast((x) => x.event === 'push')).toMatchObject({
      decision: 'deny',
      risk: 'git-default-branch',
    });
  });

  it('forwards a plain-HTTP absolute request and refuses other request lines', async () => {
    seen.length = 0;
    const answer = await new Promise<string>((resolve, reject) => {
      const socket: Socket = connect(proxyPort, '127.0.0.1');
      let data = '';
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write(
          'GET http://example.com/plain HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n',
        ),
      );
      socket.on('data', (c: Buffer) => (data += c.toString()));
      socket.on('close', () => resolve(data));
    });
    expect(answer).toContain('HTTP/1.1 200');
    expect(seen[0]!.url).toBe('/plain');
    const bad = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxyPort, '127.0.0.1');
      let data = '';
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write('GET /relative HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'),
      );
      socket.on('data', (c: Buffer) => (data += c.toString()));
      socket.on('close', () => resolve(data));
    });
    expect(bad).toContain('HTTP/1.1 400');
  });

  it('answers nothing once the principal is gone', async () => {
    await proxy.unregister();
    await expect(
      viaProxy({ host: 'api.github.com', path: '/user', trust: ca.certificate() }),
    ).rejects.toThrow();
    await proxy.register({
      connectors: ['github'],
      ask: [],
      high_risk_disabled: [],
      egress: null,
      listen_port: proxyPort,
    });
    expect(
      (await viaProxy({ host: 'api.github.com', path: '/user', trust: ca.certificate() })).status,
    ).toBe(200);
  });
});
