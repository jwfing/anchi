import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { HomeLayout } from '@anchi/core';
import type { ConnectorSecret, MethodName, Methods } from '@anchi/protocol';
import { builderAgent, BUILDER_ID, parseBlocks, Proposals } from './builder.ts';
import { Guest, LimaTransport } from './guest.ts';
import { Hub } from './hub.ts';
import { tryConnect } from './launch.ts';
import { desktopNotify } from './notify.ts';
import { Peer } from './rpc.ts';
import {
  codexStatus,
  CONNECTOR_IDS,
  connectorStatuses,
  readHostCodexLogin,
  setupStatus,
} from './setup.ts';
import { Store } from './store.ts';

export interface DaemonOptions {
  layout: HomeLayout;
  guest?: Guest;
  lima?: LimaTransport;
  log?(msg: string): void;
  /** Skip desktop notifications (tests). */
  quiet?: boolean;
  idleMs?: number;
  /** Reap guest cells at start (default true). */
  reap?: boolean;
}

type Handlers = {
  [M in MethodName]: (
    params: Methods[M][0],
    clientId: string,
  ) => Promise<Methods[M][1]> | Methods[M][1];
};

const TASK_ID = /^t-[0-9a-f]{10}$/;

function str(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.length || v.length > max) throw new Error(`invalid ${what}`);
  return v;
}

function taskId(v: unknown): string {
  if (typeof v !== 'string' || !TASK_ID.test(v)) throw new Error('invalid task id');
  return v;
}

function connectorSecret(p: unknown): ConnectorSecret {
  const v = (p ?? {}) as Record<string, unknown>;
  if (v.id === 'github' || v.id === 'linear')
    return { id: v.id, token: str(v.token, 'token', 1000) };
  if (v.id === 'aws') {
    return {
      id: 'aws',
      accessKeyId: str(v.accessKeyId, 'access key id', 200),
      secretAccessKey: str(v.secretAccessKey, 'secret access key', 200),
      sessionToken: v.sessionToken ? str(v.sessionToken, 'session token', 4096) : undefined,
      region: str(v.region, 'region', 40),
    };
  }
  throw new Error('unknown connector');
}

export class Daemon {
  readonly store: Store;
  readonly hub: Hub;
  readonly guest: Guest;
  readonly lima: LimaTransport;
  readonly proposals: Proposals;
  private server?: Server;
  private watchers: FSWatcher[] = [];
  private clients = new Map<string, Peer>();
  private startedAt = Date.now();
  private log: (msg: string) => void;

  constructor(private opts: DaemonOptions) {
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`));
    this.lima = opts.lima ?? new LimaTransport();
    this.guest = opts.guest ?? new Guest(this.lima);
    this.store = new Store(opts.layout.dbFile);
    this.proposals = new Proposals(opts.layout);
    this.hub = new Hub({
      layout: opts.layout,
      store: this.store,
      guest: this.guest,
      idleMs: opts.idleMs,
      log: this.log,
      builtins: [builderAgent()],
    });
    this.hub.on('event', (e) => this.broadcast('event', e));
    this.hub.on('agents', (agents) => this.broadcast('agents', { agents }));
    this.hub.on('task', (task) => {
      this.broadcast('tasks', { task });
      if (task.status === 'done' || task.status === 'failed') {
        this.log(`task ${task.id} (${task.agentId}) ${task.status}`);
        if (!this.opts.quiet && this.clients.size === 0) {
          void desktopNotify(`@${task.agentId} ${task.status}`, task.result ?? '');
        }
      }
    });
    this.hub.on('turnEnded', ({ task, reply }) => {
      if (task.agentId !== BUILDER_ID) return;
      const proposal = this.proposals.add(parseBlocks(reply));
      if (proposal) this.broadcast('proposal', { proposal });
    });
  }

  private broadcast(method: string, params: unknown) {
    for (const peer of this.clients.values()) peer.notify(method, params);
  }

  private handlers: Handlers = {
    'daemon.status': () => ({
      pid: process.pid,
      home: this.opts.layout.root,
      startedAt: this.startedAt,
      clients: this.clients.size,
      cells: this.hub.cellCount(),
    }),
    'daemon.shutdown': () => {
      setTimeout(() => void this.stop().then(() => process.exit(0)), 50);
      return null;
    },
    'agents.list': () => this.hub.summaries(),
    'agents.reload': () => this.hub.reload(),
    'tasks.create': ({ agentId, text }) =>
      this.hub.createTask(str(agentId, 'agent', 40), str(text, 'text', 200_000)),
    'tasks.list': ({ agentId, limit }) =>
      this.store.listTasks(agentId, Math.min(Math.max(Number(limit) || 100, 1), 500)),
    'tasks.get': ({ taskId: id }) => this.hub.getTask(taskId(id)),
    'tasks.send': ({ taskId: id, text }) =>
      this.hub.sendTask(taskId(id), str(text, 'text', 200_000)),
    'tasks.cancel': ({ taskId: id }) => {
      this.hub.cancelTask(taskId(id));
      return null;
    },
    'tasks.events': ({ taskId: id, afterSeq }) =>
      this.store.events(taskId(id), Number(afterSeq) || 0),
    'tasks.wait': ({ taskId: id }) => this.hub.wait(taskId(id)),
    'tasks.scan': async ({ taskId: id }) => {
      const task = taskId(id);
      if (!this.hub.liveTasks().includes(task)) {
        throw new Error('the task has no live cell; scan within the idle timeout after a turn');
      }
      return this.guest.scan(task);
    },
    'setup.status': () => setupStatus(this.guest, this.lima),
    'setup.importCodex': async () => {
      const login = readHostCodexLogin();
      await this.guest.importCodex(login.accessToken, login.accountId);
      return codexStatus(this.guest);
    },
    'connectors.set': async (params) => {
      const secret = connectorSecret(params);
      await this.guest.setConnector(secret);
      return (await connectorStatuses(this.guest)).find((c) => c.id === secret.id)!;
    },
    'connectors.remove': async ({ id }) => {
      if (!CONNECTOR_IDS.includes(id)) throw new Error('unknown connector');
      await this.guest.removeConnector(id);
      return (await connectorStatuses(this.guest)).find((c) => c.id === id)!;
    },
    'builder.proposal': ({ proposalId }) => this.proposals.get(str(proposalId, 'proposal', 20)),
    'builder.apply': ({ proposalId }) => {
      const { imageId } = this.proposals.apply(str(proposalId, 'proposal', 20));
      const agents = this.hub.reload();
      if (imageId) this.log(`image "${imageId}" will be built on the first task that uses it`);
      return agents;
    },
    'builder.discard': ({ proposalId }) => {
      this.proposals.discard(str(proposalId, 'proposal', 20));
      return null;
    },
  };

  async start(): Promise<void> {
    const { layout } = this.opts;
    for (const dir of [layout.root, layout.runDir, layout.dataDir, layout.agentsDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const existing = await tryConnect(layout);
    if (existing) {
      existing.close();
      throw new Error(`another daemon is already listening on ${layout.socketFile}`);
    }
    if (existsSync(layout.socketFile)) rmSync(layout.socketFile);

    // Cells from a previous daemon cannot be reattached: their runner channel was its stdio.
    if (this.opts.reap !== false) {
      try {
        const reaped = await this.guest.reap();
        if (reaped.length) this.log(`reaped orphaned cells: ${reaped.join(', ')}`);
      } catch (err) {
        this.log(`cell reap skipped: ${(err as Error).message}`);
      }
    }
    this.hub.recoverInterrupted();

    this.server = createServer((socket) => {
      const clientId = randomBytes(4).toString('hex');
      const peer = new Peer(socket, async (method, params) => {
        const handler = this.handlers[method as MethodName] as
          ((p: unknown, c: string) => unknown) | undefined;
        if (!handler) throw new Error(`unknown method ${method}`);
        return handler(params, clientId);
      });
      this.clients.set(clientId, peer);
      peer.on('close', () => this.clients.delete(clientId));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(layout.socketFile, () => resolve());
    });
    chmodSync(layout.socketFile, 0o600);
    this.watchConfig();
    this.log(`daemon ${process.pid} listening on ${layout.socketFile}`);
  }

  /** Reloads agents when any configuration file changes. */
  private watchConfig() {
    const { layout } = this.opts;
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.hub.reload(), 300);
    };
    for (const dir of [layout.agentsDir, layout.templatesDir, layout.imagesDir]) {
      if (!existsSync(dir)) continue;
      try {
        this.watchers.push(
          watch(dir, (_e, name) => name && /\.ya?ml$|\.md$/.test(String(name)) && onChange()),
        );
      } catch {
        // Watching is a convenience; `agents.reload` still works.
      }
    }
  }

  async stop(): Promise<void> {
    this.hub.shutdown();
    for (const w of this.watchers) w.close();
    for (const p of this.clients.values()) p.close();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    if (existsSync(this.opts.layout.socketFile)) rmSync(this.opts.layout.socketFile);
    this.store.close();
  }
}
