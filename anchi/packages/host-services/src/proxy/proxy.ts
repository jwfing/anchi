import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import { Transform } from 'node:stream';
import { createSecureContext, TLSSocket } from 'node:tls';
import { ControlError, type ProxyConnector } from '../control/protocol.ts';
import type { CredentialStore } from '../credentials/store.ts';
import { awsChunkResigner, type ChunkResigner } from '../sigv4/chunked.ts';
import { apply, type Credential } from '../rules/apply.ts';
import {
  classifyCredential,
  decide,
  type Decision,
  denyResponse,
  findRule,
  type Headers,
} from '../rules/decide.ts';
import { egressAllowed, egressAllowlist } from '../rules/egress.ts';
import {
  GIT_COMMANDS_MAX,
  gitPushCommands,
  gitUpdateSubject,
  highRisk,
  type RefUpdate,
  writeSummary,
} from '../rules/high-risk.ts';
import { verifyAccount, VerifyError, verifyRequests } from '../rules/verify.ts';
import { isWrite } from '../rules/writes.ts';
import { VaultError } from '../vault/envelope.ts';
import type { Approvals } from './approvals.ts';
import type { Audit } from './audit.ts';
import type { CertificateAuthority } from './ca.ts';
import type { EgressSettings } from './settings.ts';
import { readBody, resolvePublic, upstreamRequest } from './upstream.ts';

/** Bodies up to this size are read whole and decided with their contents; larger ones stream. */
export const STREAM_THRESHOLD = 8 * 1024 * 1024;
const HEAD_MAX = 64 * 1024;
const CREDENTIAL_TTL_MS = 60_000;
const CREDENTIAL_ALERTS_MAX = 20;
export const PRINCIPAL = 'host';

/** The one principal of a host placement: the user's sessions, with the latest registration. */
export interface Principal {
  grants: ReadonlySet<string>;
  ask: ReadonlySet<string>;
  highRiskDisabled: ReadonlySet<string>;
  egress: ReadonlySet<string> | null;
  /** The user's own runtime logins are expected: a credential that is not a placeholder is not an alert. */
  ownCredentials: boolean;
  credentialAlerts: Set<string>;
  egressNotices: Set<string>;
}

export interface Registration {
  connectors: ProxyConnector[];
  ask: string[];
  high_risk_disabled: string[];
  egress: string[] | null;
  listen_port: number;
}

interface Target {
  host: string;
  port: number;
  tls: boolean;
}

type Refusal = { status: number; body: Buffer; headers: Headers };

/**
 * The egress proxy of a host placement: a loopback listener the user's sessions are pointed
 * at. CONNECTs to hosts whose rule the principal is granted are terminated and decided
 * request by request as the Python proxy's `handle` did; every other CONNECT is an opaque
 * tunnel, still subject to the egress list and the public-address check by name, so the
 * runtimes' own model traffic passes untouched.
 */
export class HostProxy {
  principal: Principal | null = null;
  listenPort: number | null = null;
  private outer?: Server;
  private readonly inner: Server;
  private readonly targets = new WeakMap<Socket, Target>();
  private readonly cache = new Map<string, { until: number; value: Credential }>();

  constructor(
    private readonly deps: {
      ca: CertificateAuthority;
      audit: Audit;
      approvals: Approvals;
      credentials: CredentialStore;
      settings: () => EgressSettings;
      log: (line: string) => void;
      /** Tests point hosts at local servers; the real proxy resolves and checks every host. */
      network?: {
        resolve?: (host: string) => Promise<{ address: string | null; reason: string | null }>;
        port?: (host: string, port: number) => number;
        ca?: string;
      };
    },
  ) {
    this.inner = createHttpServer(
      { maxHeaderSize: HEAD_MAX },
      (req, res) => void this.onRequest(req, res),
    );
    this.inner.on('upgrade', (_req, socket) => {
      socket.end(
        'HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\nanchi: no WebSocket on a terminated host\n',
      );
    });
    this.inner.on('clientError', (_err, socket) => socket.destroy());
  }

  private resolve(host: string): Promise<{ address: string | null; reason: string | null }> {
    return (this.deps.network?.resolve ?? resolvePublic)(host);
  }

  private port(host: string, port: number): number {
    return this.deps.network?.port ? this.deps.network.port(host, port) : port;
  }

  // ── lifecycle ────────────────────────────────────────────

  async register(spec: Registration): Promise<{ listen_port: number }> {
    const grants = new Set<string>(spec.connectors);
    this.principal = {
      grants,
      ask: new Set(spec.ask.filter((c) => grants.has(c))),
      highRiskDisabled: new Set(spec.high_risk_disabled),
      egress: egressAllowlist(spec.egress, grants),
      ownCredentials: true,
      credentialAlerts: new Set(),
      egressNotices: new Set(),
    };
    if (this.listenPort !== spec.listen_port) {
      await this.stopListener();
      await this.listen(spec.listen_port);
    }
    this.deps.audit.row({
      event: 'register',
      task: PRINCIPAL,
      agent: PRINCIPAL,
      grants: [...grants].sort(),
      ask: [...this.principal.ask].sort(),
      high_risk_disabled: [...this.principal.highRiskDisabled].sort(),
      egress: this.principal.egress ? [...this.principal.egress].sort() : null,
      listen_port: spec.listen_port,
    });
    return { listen_port: spec.listen_port };
  }

  async unregister(): Promise<{ removed: boolean }> {
    const removed = this.principal !== null;
    this.principal = null;
    await this.stopListener();
    if (removed) this.deps.audit.row({ event: 'unregister', task: PRINCIPAL });
    return { removed };
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createHttpServer(
        { maxHeaderSize: HEAD_MAX },
        (req, res) => void this.onRequest(req, res),
      );
      server.on('connect', (req, socket, head) => void this.onConnect(req, socket as Socket, head));
      server.on('upgrade', (_req, socket) => socket.destroy());
      server.on('clientError', (_err, socket) => socket.destroy());
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(new ControlError(err.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LISTEN_FAILED'));
      });
      server.listen(port, '127.0.0.1', () => {
        this.outer = server;
        this.listenPort = port;
        resolve();
      });
    });
  }

  async stopListener(): Promise<void> {
    const server = this.outer;
    this.outer = undefined;
    this.listenPort = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async stop(): Promise<void> {
    await this.stopListener();
    this.inner.closeAllConnections();
  }

  // ── connections ──────────────────────────────────────────

  private refuseConnect(socket: Socket, status: number, text: string): void {
    const body = `anchi: ${text}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  private async onConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on('error', () => {});
    const principal = this.principal;
    const [rawHost, rawPort] = (req.url ?? '').split(':');
    const host = (rawHost ?? '').toLowerCase().replace(/\.+$/, '');
    const port = Number(rawPort || 443);
    if (!principal) return this.refuseConnect(socket, 403, 'no session is registered');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
      return this.refuseConnect(socket, 400, 'bad CONNECT target');
    if (!egressAllowed(principal.egress, host)) {
      this.deps.audit.row({
        decision: 'egress-denied',
        host: host.slice(0, 200),
        task: PRINCIPAL,
        agent: PRINCIPAL,
      });
      this.noteEgressDenied(principal, host);
      return this.refuseConnect(socket, 403, `${host} is not in the egress list`);
    }
    const rule = findRule(host);
    const terminate =
      rule !== null && rule.grant !== null && principal.grants.has(rule.grant) && port === 443;
    if (!terminate) return this.tunnel(socket, head, host, port);
    let leaf: { cert: string; key: string };
    try {
      leaf = await this.deps.ca.leaf(host);
    } catch (err) {
      this.deps.log(`certificate for ${host}: ${(err as Error).message}`);
      return this.refuseConnect(socket, 502, 'no certificate for this host');
    }
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head.length) socket.unshift(head);
    const tls = new TLSSocket(socket, {
      isServer: true,
      secureContext: createSecureContext({ key: leaf.key, cert: leaf.cert }),
      ALPNProtocols: ['http/1.1'],
    });
    tls.on('error', () => {});
    this.targets.set(tls, { host, port, tls: true });
    this.inner.emit('connection', tls);
  }

  /** Bytes both ways to the checked address; nothing inside is read. */
  private async tunnel(socket: Socket, head: Buffer, host: string, port: number): Promise<void> {
    const { address, reason } = await this.resolve(host);
    if (!address) {
      this.deps.audit.row({
        decision: 'blocked-destination',
        host: host.slice(0, 200),
        reason,
        task: PRINCIPAL,
        agent: PRINCIPAL,
      });
      return this.refuseConnect(socket, 502, reason ?? 'no address');
    }
    const upstream = connect({ host: address, port: this.port(host, port) });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    upstream.on('connect', () => {
      this.deps.audit.row({
        event: 'tunnel',
        host: host.slice(0, 200),
        port,
        decision: 'pass',
        task: PRINCIPAL,
        agent: PRINCIPAL,
      });
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }

  // ── requests ─────────────────────────────────────────────

  private respond(res: ServerResponse, refusal: Refusal): void {
    res.writeHead(refusal.status, {
      ...refusal.headers,
      'content-length': String(refusal.body.length),
      connection: 'close',
    });
    res.end(refusal.body);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      await this.serve(req, res);
    } catch (err) {
      this.deps.log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent)
        this.respond(res, {
          status: 502,
          body: Buffer.from('anchi: proxy error\n'),
          headers: { 'content-type': 'text/plain' },
        });
      else res.destroy();
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = this.principal;
    if (!principal) return this.respond(res, plain(403, 'no session is registered'));
    const target = this.targets.get(req.socket as Socket);
    let host: string;
    let port: number;
    let tls: boolean;
    let path: string;
    if (target) {
      ({ host, port, tls } = target);
      path = req.url ?? '/';
    } else {
      // A plain-HTTP request through the proxy, in absolute form.
      const match = /^http:\/\/([^/?#]+)([^#]*)$/i.exec(req.url ?? '');
      if (!match) return this.respond(res, plain(400, 'absolute http:// URLs only'));
      const [hostPart, portPart] = match[1]!.split(':');
      host = hostPart!.toLowerCase().replace(/\.+$/, '');
      port = Number(portPart || 80);
      tls = false;
      path = match[2] || '/';
    }
    const headers: Headers = {};
    for (const [k, v] of Object.entries(req.headers))
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    delete headers['proxy-authorization'];
    const named = (headers.host ?? host).split(':')[0]!.toLowerCase().replace(/\.+$/, '');
    const consistent = named === host;
    const method = (req.method ?? 'GET').toUpperCase();
    const cleanPath = path.split('?', 1)[0]!;
    const length =
      headers['content-length'] === undefined ? null : Number(headers['content-length']);
    const chunkedPush =
      method === 'POST' &&
      cleanPath.endsWith('/git-receive-pack') &&
      length === null &&
      !('content-encoding' in headers);
    const push = chunkedPush && !principal.ask.has('github');
    const streamed =
      (length !== null && length > STREAM_THRESHOLD) ||
      (length === null &&
        !push &&
        method !== 'GET' &&
        method !== 'HEAD' &&
        'transfer-encoding' in headers);
    if (push)
      return this.servePush(req, res, principal, { host, port, tls, path, headers, consistent });
    if (streamed)
      return this.serveStreamed(req, res, principal, {
        host,
        port,
        tls,
        path,
        headers,
        consistent,
        method,
      });
    const body = await readBody(req, STREAM_THRESHOLD + 1);
    if (body.length > STREAM_THRESHOLD)
      return this.respond(res, plain(413, 'a body of unknown length over 8 MiB is not forwarded'));
    const verdict = await this.handle(principal, {
      method,
      host,
      path,
      headers,
      body,
      consistent,
      streamed: false,
    });
    if ('refusal' in verdict) return this.respond(res, verdict.refusal);
    await this.forward(res, { host, port, tls, method, path, headers: verdict.headers, body });
  }

  /**
   * Decide, hold for approval and inject, as the Python proxy's `handle`: the outgoing headers,
   * or a refusal. `streamed` requests are decided on their headers alone.
   */
  private async handle(
    principal: Principal,
    r: {
      method: string;
      host: string;
      path: string;
      headers: Headers;
      body: Buffer;
      consistent: boolean;
      streamed: boolean;
      push?: boolean;
    },
  ): Promise<
    | { refusal: Refusal }
    | {
        headers: Headers;
        decision: Decision;
        resigner: ChunkResigner | null;
        entry: Record<string, unknown>;
      }
  > {
    const audit = this.deps.audit;
    const cleanPath = r.path.split('?', 1)[0]!;
    const d = decide(r.method, r.host, r.path, r.headers, r.body, principal.grants);
    const entry: Record<string, unknown> = {
      task: PRINCIPAL,
      agent: PRINCIPAL,
      method: r.method,
      host: r.host,
      path: cleanPath.slice(0, 500),
      client_cred: classifyCredential(r.headers),
      rule: d.rule?.name ?? null,
      op: d.op,
      decision: d.reason === null ? d.action : `${d.action}:${d.reason}`,
    };
    if (entry.client_cred === 'other' && !principal.ownCredentials)
      this.alertCredential(principal, entry);
    if (!r.consistent) {
      // The session asked for one host and named another: nothing leaves.
      entry.decision = 'host-mismatch';
      audit.row(entry);
      return { refusal: plain(400, 'the Host header does not name the host the request goes to') };
    }
    if (!egressAllowed(principal.egress, r.host)) {
      entry.decision = 'egress-denied';
      audit.row(entry);
      this.noteEgressDenied(principal, r.host);
      return { refusal: plain(403, `${r.host} is not in the egress list`) };
    }
    if (d.action === 'deny') {
      audit.row(entry);
      return { refusal: denyResponse(d, r.headers) };
    }
    if (d.action === 'pass') {
      audit.row(entry);
      return { headers: r.headers, decision: d, resigner: null, entry };
    }
    const rule = d.rule!;
    if (r.streamed && !r.push && !(rule.kind === 'aws_sigv4' && (d.op ?? '').startsWith('s3:'))) {
      entry.decision = 'pass:streamed';
      audit.row(entry);
      return { headers: r.headers, decision: d, resigner: null, entry };
    }
    // High-risk operations wait for the user whatever the settings; other writes wait when the
    // session's approvals ask for the connector.
    const risk = r.streamed
      ? null
      : highRisk(
          d,
          r.method,
          r.path,
          r.body,
          this.deps.settings().high_risk_disabled.concat([...principal.highRiskDisabled]),
        );
    if (
      !r.streamed &&
      (risk ||
        (rule.grant !== null &&
          principal.ask.has(rule.grant) &&
          isWrite(d, r.method, r.path, r.body)))
    ) {
      entry.risk = risk ? risk[0] : null;
      const outcome = await this.deps.approvals.ask({
        task: PRINCIPAL,
        agent: PRINCIPAL,
        connector: rule.grant ?? '',
        operation: String(d.op ?? ''),
        host: r.host,
        summary: writeSummary(d, r.method, cleanPath, r.body),
        reason: risk ? `high-risk: ${risk[1]}` : `approvals: ${rule.grant} asks`,
      });
      entry.approval = outcome;
      if (outcome !== 'approved') {
        entry.decision = `held-${outcome}`;
        audit.row(entry);
        return {
          refusal: plain(
            403,
            `approval for this write ${outcome === 'timeout' ? 'timed out' : 'was denied'}`,
          ),
        };
      }
    }
    let credential: Credential;
    try {
      credential = this.credential(rule.grant ?? '');
    } catch (err) {
      entry.decision = 'missing-credential';
      entry.reason = String((err as Error).message).slice(0, 100);
      audit.row(entry);
      return { refusal: plain(502, `credential unavailable (${(err as Error).message})`) };
    }
    let fresh: Headers;
    let resigner: ChunkResigner | null = null;
    try {
      fresh = apply(
        d,
        r.method,
        `${r.host.includes(':') ? 'https' : 'https'}://${r.host}${r.path}`,
        r.headers,
        r.body,
        credential,
      );
      if (rule.kind === 'aws_sigv4') resigner = awsChunkResigner(fresh, credential as never);
    } catch (err) {
      entry.decision = 'rejected';
      entry.reason = String((err as Error).message).slice(0, 200);
      audit.row(entry);
      return { refusal: plain(403, String((err as Error).message)) };
    }
    audit.row(entry);
    return { headers: fresh, decision: d, resigner, entry };
  }

  /** Opens the upstream connection to the checked address and relays the response. */
  private async forward(
    res: ServerResponse,
    r: {
      host: string;
      port: number;
      tls: boolean;
      method: string;
      path: string;
      headers: Headers;
      body: Buffer | import('node:stream').Readable | null;
    },
  ): Promise<void> {
    const { address, reason } = await this.resolve(r.host);
    if (!address) {
      this.deps.audit.row({
        decision: 'blocked-destination',
        host: r.host.slice(0, 200),
        reason,
        task: PRINCIPAL,
        agent: PRINCIPAL,
      });
      return this.respond(res, plain(502, reason ?? 'no address'));
    }
    let upstream;
    try {
      upstream = await upstreamRequest({
        address,
        host: r.host,
        port: this.port(r.host, r.port),
        ca: this.deps.network?.ca,
        tls: r.tls,
        method: r.method,
        path: r.path,
        headers: r.headers,
        body: r.body,
      });
    } catch (err) {
      this.deps.audit.row({
        decision: 'upstream-error',
        host: r.host.slice(0, 200),
        reason: String((err as Error).message).slice(0, 200),
        task: PRINCIPAL,
        agent: PRINCIPAL,
      });
      return this.respond(res, plain(502, `upstream error: ${(err as Error).message}`));
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (
        v === undefined ||
        ['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection'].includes(k)
      )
        continue;
      headers[k] = v;
    }
    res.writeHead(upstream.status, headers);
    upstream.body.on('error', () => res.destroy());
    res.on('close', () => upstream.body.destroy());
    upstream.body.pipe(res);
  }

  /** A streamed body (over 8 MiB, or chunked without a length): decided on the headers alone. */
  private async serveStreamed(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    r: {
      host: string;
      port: number;
      tls: boolean;
      path: string;
      headers: Headers;
      consistent: boolean;
      method: string;
    },
  ): Promise<void> {
    const verdict = await this.handle(principal, { ...r, body: Buffer.alloc(0), streamed: true });
    if ('refusal' in verdict) {
      req.resume();
      return this.respond(res, verdict.refusal);
    }
    let body: import('node:stream').Readable = req;
    const resigner = verdict.resigner;
    if (resigner) {
      const entry = verdict.entry;
      const audit = this.deps.audit;
      // Throwing ends the connection, so upstream gets a truncated body, never a forged one.
      body = req.pipe(
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            try {
              done(null, resigner.feed(chunk));
            } catch (err) {
              audit.row({
                ...entry,
                decision: 'rejected',
                reason: String((err as Error).message).slice(0, 200),
              });
              done(err as Error);
            }
          },
          flush(done) {
            try {
              done(null, resigner.feed(Buffer.alloc(0)));
            } catch (err) {
              done(err as Error);
            }
          },
        }),
      );
    }
    await this.forward(res, { ...r, headers: verdict.headers, body });
  }

  /**
   * A chunked git push: nothing of the body leaves until the ref updates at its start have
   * been read and checked; then all of it goes, or none of it and git gets a report of the
   * rejected refs. A high-risk push cannot wait for approval here, so it is refused.
   */
  private async servePush(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    r: {
      host: string;
      port: number;
      tls: boolean;
      path: string;
      headers: Headers;
      consistent: boolean;
    },
  ): Promise<void> {
    const verdict = await this.handle(principal, {
      ...r,
      method: 'POST',
      body: Buffer.alloc(0),
      streamed: true,
      push: true,
    });
    if ('refusal' in verdict) {
      req.resume();
      return this.respond(res, verdict.refusal);
    }
    const entry = verdict.entry;
    if (verdict.decision.action !== 'inject') {
      // Not granted: the push leaves as the session sent it.
      return this.forward(res, { ...r, method: 'POST', headers: verdict.headers, body: req });
    }
    let buffered = Buffer.alloc(0);
    let parsed: [RefUpdate[], Set<string>] | null = null;
    let failure: string | null = null;
    const ended = await new Promise<boolean>((resolve) => {
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        try {
          parsed = gitPushCommands(buffered.subarray(0, GIT_COMMANDS_MAX));
          if (parsed === null && buffered.length >= GIT_COMMANDS_MAX)
            throw new Error('the push ended before its ref updates');
        } catch (err) {
          failure = (err as Error).message;
        }
        if (parsed !== null || failure !== null) {
          req.removeListener('data', onData);
          req.pause();
          resolve(false);
        }
      };
      req.on('data', onData);
      req.once('end', () => {
        if (parsed === null && failure === null) failure = 'the push ended before its ref updates';
        resolve(true);
      });
      req.once('error', () => {
        failure = 'the push ended before its ref updates';
        resolve(true);
      });
    });
    const row = (updates: RefUpdate[], decision: string, extra: Record<string, unknown> = {}) => ({
      event: 'push',
      task: PRINCIPAL,
      agent: PRINCIPAL,
      host: r.host,
      path: entry.path,
      op: `git push: ${updates
        .slice(0, 50)
        .map((u) => gitUpdateSubject(...u))
        .join(', ')}`.slice(0, 500),
      decision,
      ...extra,
    });
    const refuse = (updates: RefUpdate[], caps: Set<string>, risk: [string, string]) => {
      const reason = `${risk[1]}: a push this large cannot wait for approval; push to another branch and open a pull request`;
      this.deps.audit.row(row(updates, 'deny', { risk: risk[0], reason: reason.slice(0, 200) }));
      this.deps.approvals.broadcast({
        type: 'notice',
        task: PRINCIPAL,
        text: `⛔ git push refused: ${row(updates, 'deny').op.slice(10) || 'unreadable ref updates'} (${reason})`.slice(
          0,
          500,
        ),
      });
      req.resume();
      this.respond(
        res,
        gitRejection(
          updates.map((u) => u[2]),
          caps,
          reason,
        ),
      );
    };
    if (failure !== null || parsed === null)
      return refuse([], new Set(), ['github-push-unreadable', failure ?? 'unreadable']);
    const [updates, caps] = parsed as [RefUpdate[], Set<string>];
    const risk = highRisk(
      verdict.decision,
      'POST',
      r.path,
      buffered.subarray(0, GIT_COMMANDS_MAX),
      this.deps.settings().high_risk_disabled.concat([...principal.highRiskDisabled]),
    );
    if (risk) return refuse(updates, caps, risk);
    this.deps.audit.row(row(updates, 'inject'));
    entry.push = 'streamed';
    const { PassThrough } = await import('node:stream');
    const body = new PassThrough();
    body.write(buffered);
    if (ended) body.end();
    else {
      req.pipe(body);
      req.resume();
    }
    await this.forward(res, { ...r, method: 'POST', headers: verdict.headers, body });
  }

  // ── credentials, verification, notices ───────────────────

  private credential(grant: string): Credential {
    const hit = this.cache.get(grant);
    if (hit && hit.until > Date.now()) return hit.value;
    let value: Record<string, unknown>;
    try {
      value = this.deps.credentials.egressCredential(grant);
    } catch (err) {
      throw new Error(
        err instanceof VaultError || err instanceof ControlError
          ? ((err as { code?: string }).code ?? err.message)
          : 'CREDENTIAL_ERROR',
      );
    }
    this.cache.set(grant, { until: Date.now() + CREDENTIAL_TTL_MS, value: value as Credential });
    return value as Credential;
  }

  /** Calls the connector's identity endpoint with the stored credential, read afresh. */
  async verify(connector: string): Promise<{ connector: string; account: string }> {
    this.cache.delete(connector);
    let credential: Credential;
    try {
      credential = this.credential(connector);
    } catch (err) {
      throw new ControlError(`NO_CREDENTIAL:${(err as Error).message}`);
    }
    let last: { status: number; body: Buffer; url: string } | null = null;
    for (const request of verifyRequests(connector, credential)) {
      const { host } = splitUrl(request.url);
      const { address } = await this.resolve(host);
      if (!address) throw new ControlError('VERIFY_UNREACHABLE');
      let status: number;
      let body: Buffer;
      try {
        const response = await upstreamRequest({
          address,
          host,
          port: this.port(host, 443),
          ca: this.deps.network?.ca,
          tls: true,
          method: request.method,
          path: request.url.slice(request.url.indexOf(host) + host.length) || '/',
          headers: { ...request.headers, host },
          body: request.body.length ? request.body : null,
          timeoutMs: 30_000,
        });
        status = response.status;
        body = await readBody(response.body, 65536);
      } catch {
        throw new ControlError('VERIFY_UNREACHABLE');
      }
      this.deps.audit.row({ event: 'verify', connector, status });
      last = { status, body, url: request.url };
      if (status !== 401 && status !== 403) break;
    }
    try {
      return { connector, account: verifyAccount(connector, last!.status, last!.body, last!.url) };
    } catch (err) {
      throw new ControlError(
        err instanceof VerifyError ? err.message : 'VERIFY_UNEXPECTED_RESPONSE',
      );
    }
  }

  private alertCredential(principal: Principal, entry: Record<string, unknown>): void {
    const host = String(entry.host);
    if (
      principal.credentialAlerts.has(host) ||
      principal.credentialAlerts.size >= CREDENTIAL_ALERTS_MAX
    )
      return;
    principal.credentialAlerts.add(host);
    this.deps.approvals.broadcast({
      type: 'credential',
      task: PRINCIPAL,
      agent: PRINCIPAL,
      method: String(entry.method),
      host: host.slice(0, 200),
      path: String(entry.path).slice(0, 200),
    });
  }

  private noteEgressDenied(principal: Principal, host: string): void {
    if (principal.egressNotices.has(host) || principal.egressNotices.size >= CREDENTIAL_ALERTS_MAX)
      return;
    principal.egressNotices.add(host);
    this.deps.approvals.broadcast({
      type: 'notice',
      task: PRINCIPAL,
      text: `⛔ ${host.slice(0, 200)} is not in the egress list; the connection was refused. To allow it, add it to egress in ~/.anchi/host/profile.json`,
    });
  }
}

function plain(status: number, text: string): Refusal {
  return {
    status,
    body: Buffer.from(`anchi: ${text}\n`),
    headers: { 'content-type': 'text/plain' },
  };
}

const pkt = (line: Buffer) =>
  Buffer.concat([Buffer.from((line.length + 4).toString(16).padStart(4, '0')), line]);

/** What git shows as `! [remote rejected] REF (anchi: reason)`. */
export function gitRejection(refs: string[], caps: Set<string>, reason: string): Refusal {
  const message = Buffer.from(`anchi: ${reason}`, 'ascii');
  if (!refs.length || !(caps.has('report-status') || caps.has('report-status-v2'))) {
    return {
      status: 403,
      body: Buffer.concat([message, Buffer.from('\n')]),
      headers: { 'content-type': 'text/plain' },
    };
  }
  let report = Buffer.concat([
    pkt(Buffer.from('unpack ok\n')),
    ...refs.map((ref) =>
      pkt(Buffer.concat([Buffer.from(`ng ${ref} `), message, Buffer.from('\n')])),
    ),
    Buffer.from('0000'),
  ]);
  if (caps.has('side-band-64k') || caps.has('side-band')) {
    const size = caps.has('side-band-64k') ? 65515 : 995;
    const bands: Buffer[] = [];
    for (let i = 0; i < report.length; i += size)
      bands.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + size)])));
    report = Buffer.concat([...bands, Buffer.from('0000')]);
  }
  return {
    status: 200,
    body: report,
    headers: {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
    },
  };
}

function splitUrl(url: string): { host: string } {
  const match = /^https?:\/\/([^/?#]*)/i.exec(url);
  return { host: match?.[1] ?? '' };
}
