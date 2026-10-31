import { bridgeMissing, type SavedServer } from '@anchi/daemon/client';
import type { DaemonStatus, Notifications } from '@anchi/protocol';
import type { ServerState } from '../shared.ts';
import { guardedCall, NOTIFICATIONS, type Confirmation, type Read } from './bridge.ts';

export interface Connection {
  read: Read;
  /** What the daemon said about itself when the connection opened (absent for older daemons). */
  daemon?: Partial<DaemonStatus>;
  on(name: keyof Notifications, listener: (params: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

interface Entry {
  state: ServerState;
  generation: number;
  client?: Connection;
  retry?: ReturnType<typeof setTimeout>;
}

/** Each machine owns its connection, retries and notifications. Selection never changes routing. */
export class Connections {
  private entries = new Map<string, Entry>();

  constructor(
    private opts: {
      open(target: string): Promise<Connection>;
      changed(states: ServerState[]): void;
      notify(server: string, name: keyof Notifications, params: unknown): void;
    },
  ) {}

  states(): ServerState[] {
    return [...this.entries.values()].map((entry) => entry.state);
  }

  private publish() {
    this.opts.changed(this.states());
  }

  add(server: SavedServer) {
    if (this.entries.has(server.target)) return;
    this.entries.set(server.target, {
      state: { name: server.target, label: server.name, status: 'disconnected' },
      generation: 0,
    });
    this.publish();
  }

  private entry(target: unknown): Entry {
    const entry = typeof target === 'string' ? this.entries.get(target) : undefined;
    if (!entry) throw new Error('unknown machine: choose a saved machine');
    return entry;
  }

  private stop(entry: Entry) {
    entry.generation++;
    clearTimeout(entry.retry);
    entry.retry = undefined;
    const client = entry.client;
    entry.client = undefined;
    client?.close();
  }

  async connect(target: string): Promise<void> {
    const entry = this.entry(target);
    if (['connected', 'connecting', 'installing'].includes(entry.state.status)) return;
    this.stop(entry);
    const generation = entry.generation;
    const current = () => this.entries.get(target) === entry && generation === entry.generation;
    entry.state = { name: target, label: entry.state.label, status: 'connecting' };
    this.publish();
    const failed = (error: string, delay: number) => {
      if (!current()) return;
      entry.client = undefined;
      entry.state = { ...entry.state, status: 'error', error };
      this.publish();
      entry.retry = setTimeout(() => void this.connect(target), delay);
    };
    let client: Connection;
    try {
      client = await this.opts.open(target);
    } catch (err) {
      if (current() && bridgeMissing(err)) {
        this.setupState(target, 'needs-setup');
        return;
      }
      failed(err instanceof Error ? err.message : 'connection failed', 5000);
      return;
    }
    if (!current()) {
      client.close();
      return;
    }
    entry.client = client;
    for (const name of NOTIFICATIONS) {
      client.on(name, (params) => {
        if (current() && entry.client === client) this.opts.notify(target, name, params);
      });
    }
    client.onClose(() => failed('connection to the daemon closed', 3000));
    // Version and install kind decide whether the app offers an upgrade; an older daemon omits them.
    const daemon = client.daemon;
    entry.state = {
      ...entry.state,
      status: 'connected',
      ...(typeof daemon?.version === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(daemon.version)
        ? { version: daemon.version }
        : {}),
      ...(daemon?.install === 'release' || daemon?.install === 'source'
        ? { install: daemon.install }
        : {}),
    };
    this.publish();
  }

  disconnect(target: string) {
    const entry = this.entry(target);
    this.stop(entry);
    entry.state = { name: target, label: entry.state.label, status: 'disconnected' };
    this.publish();
  }

  setupState(target: string, status: 'needs-setup' | 'installing', error?: string) {
    const entry = this.entry(target);
    this.stop(entry);
    entry.state = { name: target, label: entry.state.label, status, ...(error ? { error } : {}) };
    this.publish();
  }

  /** A saved machine can be confirmed before its daemon exists. */
  pin(target: string): () => void {
    const entry = this.entry(target);
    const generation = entry.generation;
    return () => {
      if (this.entries.get(target) !== entry || entry.generation !== generation) {
        throw new Error('machine connection changed; review the action again');
      }
    };
  }

  remove(target: string) {
    const entry = this.entry(target);
    this.stop(entry);
    this.entries.delete(target);
    this.publish();
  }

  /** Pin native dialogs and confirmations to the connection on which they started. */
  lease(target: unknown): { state: ServerState; read: Read } {
    const entry = this.entry(target);
    const client = entry.client;
    const generation = entry.generation;
    if (!client || entry.state.status !== 'connected')
      throw new Error(`${entry.state.label}: not connected`);
    return {
      state: entry.state,
      read: (method, params) => {
        if (
          this.entries.get(entry.state.name) !== entry ||
          generation !== entry.generation ||
          client !== entry.client
        ) {
          throw new Error('machine connection changed; review the action again');
        }
        return client.read(method, params);
      },
    };
  }

  async call(
    target: unknown,
    method: unknown,
    params: unknown,
    confirm: (q: Confirmation) => Promise<boolean>,
  ) {
    const lease = this.lease(target);
    return guardedCall(method, params, lease.read, (question) =>
      confirm({
        ...question,
        detail: `Machine: ${lease.state.label} (${lease.state.name})\n\n${question.detail}`,
      }),
    );
  }

  close() {
    for (const entry of this.entries.values()) this.stop(entry);
    this.entries.clear();
  }
}
