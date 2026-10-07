import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import {
  CLIENT_MAX_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  type MethodName,
  type Notifications,
  type Params,
  type Result,
} from '@anchi/protocol';

/**
 * Newline-delimited JSON-RPC over a stream socket.
 * Request: {id, method, params}; response: {id, result} | {id, error}; notification: {method, params}.
 * A frame over the limit or a line that is not JSON closes the connection.
 */
type Frame =
  | { id: number; method: string; params: unknown }
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { method: string; params: unknown };

function isFrame(v: unknown): v is Frame {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class Peer extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private decoder: FrameDecoder;
  closed = false;

  constructor(
    readonly socket: Socket,
    private handler?: (method: string, params: unknown) => Promise<unknown>,
    maxFrameBytes = CLIENT_MAX_FRAME_BYTES,
  ) {
    super();
    this.decoder = new FrameDecoder(
      maxFrameBytes,
      (value) => {
        if (isFrame(value)) void this.onFrame(value);
        else this.decoder.fail('frame is not an object');
      },
      (err) => {
        this.emit('protocolError', err);
        socket.destroy();
      },
    );
    socket.on('data', (chunk: Buffer) => this.decoder.push(chunk));
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      this.emit('close');
    });
    socket.on('error', (err) => this.emit('socketError', err));
  }

  private async onFrame(frame: Frame) {
    if ('id' in frame && 'method' in frame) {
      if (!this.handler) return this.send({ id: frame.id, error: { message: 'no handler' } });
      try {
        const result = await this.handler(frame.method, frame.params ?? {});
        this.send({ id: frame.id, result: result ?? null });
      } catch (err) {
        this.send({ id: frame.id, error: { message: (err as Error).message } });
      }
    } else if ('id' in frame) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if ('error' in frame) p.reject(new Error(frame.error.message));
      else p.resolve(frame.result);
    } else if ('method' in frame) {
      this.emit('notification', frame.method, frame.params);
    }
  }

  private send(frame: Frame) {
    if (this.closed) return;
    this.socket.write(encodeFrame(frame));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connection closed'));
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  close(): void {
    this.socket.end();
  }
}

/** Typed client for the daemon socket. */
export class DaemonClient {
  private constructor(private peer: Peer) {}

  static connect(socketPath: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once('connect', () => resolve(new DaemonClient(new Peer(socket))));
      socket.once('error', reject);
    });
  }

  call<M extends MethodName>(
    method: M,
    ...params: Params<M> extends Record<string, never> ? [] : [Params<M>]
  ): Promise<Result<M>> {
    return this.peer.request(method, params[0] ?? {}) as Promise<Result<M>>;
  }

  on<N extends keyof Notifications>(name: N, cb: (params: Notifications[N]) => void): () => void {
    const listener = (method: string, params: unknown) => {
      if (method === name) cb(params as Notifications[N]);
    };
    this.peer.on('notification', listener);
    return () => this.peer.off('notification', listener);
  }

  onClose(cb: () => void): void {
    this.peer.on('close', cb);
  }

  close(): void {
    this.peer.close();
  }
}
