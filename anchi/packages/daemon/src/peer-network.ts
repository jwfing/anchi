import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { connect, createServer, type Server, type TLSSocket } from 'node:tls';
import type { HomeLayout } from '@anchi/core';
import {
  peerNodeSchema,
  peerNetworkConfigSchema,
  peerRecordSchema,
  peerSyncSchema,
  type AgentSummary,
  type PeerDirectory,
  type PeerNetworkConfig,
  type PeerRecord,
} from '@anchi/protocol';
import { z } from 'zod';
import { Peer } from './rpc.ts';
import type { Store } from './store.ts';

const allowed = new Set(['peer.sync', 'task.run', 'task.poll', 'task.cancel', 'task.approve']);
const generations = z.record(z.string(), z.string().regex(/^[0-9a-f]{16}$/));
const removedSchema = z.array(peerNodeSchema).max(1000);
function publicKey(certificate: string | Buffer): string {
  const cert = new X509Certificate(certificate);
  if (
    !cert.verify(cert.publicKey) ||
    Date.parse(cert.validTo) < Date.now() ||
    Date.parse(cert.validFrom) > Date.now()
  )
    throw new Error('PEER_CERTIFICATE_INVALID');
  return createHash('sha256')
    .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}
function payload(record: PeerRecord): Buffer {
  const { signature: _, ...data } = record;
  return Buffer.from(JSON.stringify(data));
}

/** Authenticated peer transport. Only this small protocol is exposed, never the owner socket. */
export class PeerNetwork {
  private server?: Server;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private ticking = false;
  private catalogCursor = 0;
  private links = new Map<string, Peer>();
  private dialing = new Map<string, Promise<Peer>>();
  private sockets = new Set<Socket>();
  private config?: PeerNetworkConfig;
  readonly node: string;

  constructor(
    private opts: {
      layout: HomeLayout;
      store: Store;
      agents(): AgentSummary[];
      handle(node: string, method: string, params: unknown): Promise<unknown>;
      changed?(): void;
      intervalMs?: number;
    },
  ) {
    this.node = opts.store.nodeId();
    this.config = opts.store.teamGet('peer/config', peerNetworkConfigSchema);
  }

  private keys() {
    const dir = join(this.opts.layout.root, 'peers');
    const identityDir = join(dir, 'identity');
    const key = join(identityDir, 'tls.key');
    const cert = join(identityDir, 'tls.pem');
    if (!existsSync(key) || !existsSync(cert)) {
      if (existsSync(key) || existsSync(cert)) throw new Error('PEER_IDENTITY_INCOMPLETE');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temporary = mkdtempSync(join(dir, '.identity-'));
      try {
        const privateKey = join(temporary, 'tls.key');
        const certificate = join(temporary, 'tls.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'ec',
            '-pkeyopt',
            'ec_paramgen_curve:prime256v1',
            '-nodes',
            '-keyout',
            privateKey,
            '-out',
            certificate,
            '-days',
            '3650',
            '-subj',
            `/CN=anchi-${this.node}`,
          ],
          { stdio: 'ignore' },
        );
        chmodSync(privateKey, 0o600);
        renameSync(temporary, identityDir);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    return { key: readFileSync(key), cert: readFileSync(cert, 'utf8') };
  }

  identity(): PeerRecord {
    if (!this.config) throw new Error('PEER_NETWORK_NOT_CONFIGURED');
    const keys = this.keys();
    const known = this.opts.store.teamGet('peer/generations', generations) ?? {};
    const agents = this.opts.agents().filter((a) => a.id !== 'builder' && !a.error && !a.execution);
    const next: Record<string, string> = {};
    const record: PeerRecord = {
      node: this.node,
      label: this.config.label,
      address: this.config.address,
      certificate: keys.cert,
      revision: 1,
      agents: agents
        .slice(0, 200)
        .map((a) => {
          const generation = known[a.id] ?? randomBytes(8).toString('hex');
          next[a.id] = generation;
          return {
            id: a.id,
            generation,
            name: a.name.slice(0, 100),
            description: (a.description ?? '').slice(0, 500),
            runtime: a.runtime ?? '',
            connectors: a.connectors,
            skills: (a.skills ?? []).slice(0, 50),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      signature: '-',
    };
    const previous = this.opts.store.teamGet(`peer/record/${this.node}`, peerRecordSchema);
    if (previous) {
      record.revision = previous.revision;
      if (payload(previous).equals(payload(record))) return previous;
      record.revision++;
    }
    record.signature = sign('sha256', payload(record), keys.key).toString('base64');
    peerRecordSchema.parse(record);
    this.opts.store.transaction(() => {
      this.opts.store.teamPut('peer/generations', next);
      this.opts.store.teamPut(`peer/record/${this.node}`, record);
    });
    return record;
  }

  private removed(): string[] {
    return this.opts.store.teamGet('peer/removed', removedSchema) ?? [];
  }
  private records(): PeerRecord[] {
    return this.opts.store
      .teamEntries('peer/record/', peerRecordSchema)
      .filter((r) => !this.removed().includes(r.node));
  }

  private catalogBatch(): PeerRecord[] {
    const records = this.records();
    const record = records[this.catalogCursor++ % records.length];
    return record ? [record] : [];
  }

  admit(raw: unknown): void {
    const record = peerRecordSchema.parse(raw);
    if (this.removed().includes(record.node)) throw new Error('PEER_REVOKED');
    const fingerprint = publicKey(record.certificate);
    if (
      !verify(
        'sha256',
        payload(record),
        new X509Certificate(record.certificate).publicKey,
        Buffer.from(record.signature, 'base64'),
      )
    )
      throw new Error('PEER_RECORD_SIGNATURE_INVALID');
    const previous = this.opts.store.teamGet(`peer/record/${record.node}`, peerRecordSchema);
    if (previous && publicKey(previous.certificate) !== fingerprint)
      throw new Error('PEER_IDENTITY_CHANGED');
    if (
      record.node !== this.node &&
      (publicKey(this.keys().cert) === fingerprint ||
        this.records().some(
          (r) => r.node !== record.node && publicKey(r.certificate) === fingerprint,
        ))
    )
      throw new Error('PEER_DUPLICATE_KEY');
    if (record.node === this.node) {
      if (fingerprint !== publicKey(this.keys().cert)) throw new Error('PEER_SELF_IDENTITY');
      return;
    }
    if (previous && previous.revision >= record.revision) return;
    if (!previous && this.records().length >= 32) throw new Error('PEER_LIMIT');
    this.opts.store.teamPut(`peer/record/${record.node}`, record);
    if (!this.stopped) this.opts.changed?.();
    void this.tick();
  }

  remove(node: string): void {
    peerNodeSchema.parse(node);
    if (this.removed().includes(node)) return;
    if (node === this.node) throw new Error('PEER_CANNOT_REMOVE_SELF');
    const removed = [...new Set([...this.removed(), node])];
    if (removed.length > 1000) throw new Error('PEER_REMOVAL_LIMIT');
    this.opts.store.teamPut('peer/removed', removed);
    this.links.get(node)?.close();
    this.links.delete(node);
    if (!this.stopped) this.opts.changed?.();
  }

  directory(): PeerDirectory {
    if (this.config) this.identity();
    return {
      self: this.node,
      configured: !!this.config,
      ...(this.config ? { config: { ...this.config } } : {}),
      nodes: this.records().map(({ certificate: _, signature: __, ...r }) => ({
        ...r,
        online: r.node === this.node || this.links.has(r.node),
      })),
    };
  }

  async configure(raw: unknown): Promise<PeerRecord> {
    const config = peerNetworkConfigSchema.parse(raw);
    const previous = this.config;
    await this.stop();
    this.stopped = false;
    this.config = config;
    try {
      await this.start();
    } catch (error) {
      await this.stop();
      this.config = previous;
      await this.start();
      throw error;
    }
    this.opts.store.teamPut('peer/config', this.config);
    return this.identity();
  }

  async start(): Promise<void> {
    if (!this.config || this.server) return;
    this.stopped = false;
    this.server = createServer(
      {
        ...this.keys(),
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        handshakeTimeout: 5000,
      },
      (socket) => {
        try {
          if (this.stopped) throw new Error('PEER_UNAVAILABLE');
          const raw = socket.getPeerCertificate().raw;
          if (!raw) throw new Error('PEER_CERTIFICATE_REQUIRED');
          const fingerprint = publicKey(raw);
          const owner = this.records().find(
            (r) => r.node !== this.node && publicKey(r.certificate) === fingerprint,
          );
          if (!owner) throw new Error('PEER_NOT_PAIRED');
          this.attach(owner.node, socket);
        } catch {
          socket.destroy();
        }
      },
    );
    this.server.maxConnections = 64;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config!.port, this.config!.listen, resolve);
    });
    const address = this.server.address();
    if (address && typeof address !== 'string' && this.config.port === 0) {
      this.config.port = address.port;
      const advertised = new URL(this.config.address);
      if (advertised.port === '0') advertised.port = String(address.port);
      this.config.address = advertised.toString();
    }
    this.identity();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3000);
    this.timer.unref();
    void this.tick();
  }

  private attach(node: string, socket: TLSSocket): Peer {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const peer = new Peer(socket, (method, params) => this.handle(node, method, params));
    const old = this.links.get(node);
    if (old && !old.closed) {
      socket.destroy();
      return old;
    }
    this.links.set(node, peer);
    peer.on('close', () => {
      if (this.links.get(node) === peer) this.links.delete(node);
      if (!this.stopped) this.opts.changed?.();
    });
    if (!this.stopped) this.opts.changed?.();
    return peer;
  }

  private async connection(node: string): Promise<Peer> {
    if (this.stopped) throw new Error('PEER_UNAVAILABLE');
    if (this.removed().includes(node)) throw new Error('PEER_REVOKED');
    const existing = this.links.get(node);
    if (existing && !existing.closed) return existing;
    const pending = this.dialing.get(node);
    if (pending) return pending;
    const record = this.records().find((r) => r.node === node && node !== this.node);
    if (!record) throw new Error('PEER_NOT_PAIRED');
    const work = new Promise<Peer>((resolve, reject) => {
      const url = new URL(record.address);
      const socket = connect({
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port),
        ...this.keys(),
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
      });
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      const timer = setTimeout(() => socket.destroy(new Error('PEER_CONNECTION_TIMEOUT')), 5000);
      socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('connection closed'));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        try {
          const raw = socket.getPeerCertificate().raw;
          if (!raw || publicKey(raw) !== publicKey(record.certificate))
            throw new Error('PEER_IDENTITY_CHANGED');
          if (this.stopped || this.removed().includes(node)) throw new Error('PEER_REVOKED');
          resolve(this.attach(node, socket));
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
    }).finally(() => this.dialing.delete(node));
    this.dialing.set(node, work);
    return work;
  }

  async request(node: string, method: string, params: unknown): Promise<unknown> {
    if (!allowed.has(method)) throw new Error('PEER_METHOD_DENIED');
    const peer = await this.connection(node);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        peer.request(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            peer.socket.destroy();
            reject(new Error('PEER_REQUEST_TIMEOUT'));
          }, 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async handle(node: string, method: string, params: unknown): Promise<unknown> {
    if (this.removed().includes(node)) throw new Error('PEER_REVOKED');
    if (!allowed.has(method)) throw new Error('PEER_METHOD_DENIED');
    if (method !== 'peer.sync') return this.opts.handle(node, method, params);
    const sync = peerSyncSchema.parse(params);
    for (const id of sync.removed) {
      if (id === this.node) throw new Error('PEER_REVOKED');
      this.remove(id);
    }
    for (const record of sync.records)
      if (!this.removed().includes(record.node)) this.admit(record);
    this.identity();
    return { records: this.catalogBatch(), removed: this.removed() };
  }

  private async tick() {
    if (this.stopped || this.ticking || !this.config) return;
    this.ticking = true;
    try {
      this.identity();
      await Promise.allSettled(
        this.records()
          .filter((r) => r.node !== this.node)
          .map(async (record) => {
            // A deterministic dialer avoids two peers replacing each other's live connection.
            if (this.node > record.node && !this.links.has(record.node)) return;
            const response = peerSyncSchema.parse(
              await this.request(record.node, 'peer.sync', {
                records: this.catalogBatch(),
                removed: this.removed(),
              }),
            );
            if (this.stopped) return;
            for (const id of response.removed) if (id !== this.node) this.remove(id);
            for (const r of response.records) if (!this.removed().includes(r.node)) this.admit(r);
          }),
      );
    } finally {
      this.ticking = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const peer of this.links.values()) peer.socket.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.links.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(this.dialing.values());
  }
}
