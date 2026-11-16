import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  CONTROL_MAX,
  CONTROL_OPS,
  ControlError,
  type ControlRequest,
  type ControlResponse,
  requestSchema,
} from './protocol.ts';

/**
 * A handler answers one request; a watch handler keeps the socket and writes lines to it until
 * `close` is called (the client left).
 */
export type Handler = (request: ControlRequest) => Promise<unknown> | unknown;
export type WatchHandler = (
  write: (line: string) => void,
  onClose: (fn: () => void) => void,
) => void;

/**
 * The control socket: a Unix socket the daemon reaches, mode 0600 in a 0700 directory, with a
 * token beside it (0600) that every request carries. Node cannot read the peer's UID, so the
 * token is what proves the caller can read the user's files; the file modes keep other users
 * out of the socket itself, as the Python services' peer-UID check did.
 */
export class ControlServer {
  private server?: Server;
  private readonly token = randomBytes(32).toString('hex');
  private readonly tokenBuffer: Buffer;
  private watches = new Set<Socket>();

  constructor(
    readonly socketPath: string,
    readonly tokenPath: string,
    private handlers: Partial<Record<ControlRequest['op'], Handler>>,
    private watchHandler?: WatchHandler,
  ) {
    this.tokenBuffer = Buffer.from(this.token, 'utf8');
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });
    writeFileSync(this.tokenPath, this.token, { mode: 0o600 });
    chmodSync(this.tokenPath, 0o600);
    this.server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    for (const socket of this.watches) socket.destroy();
    this.watches.clear();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    rmSync(this.socketPath, { force: true });
    rmSync(this.tokenPath, { force: true });
  }

  private serve(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let done = false;
    const answer = (response: ControlResponse) => {
      socket.end(`${JSON.stringify(response)}\n`);
    };
    const refuse = (code: string) => {
      done = true;
      answer({ ok: false, error: code });
    };
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(0x0a);
      if (end === -1) {
        if (buffer.length > CONTROL_MAX) refuse('BAD_REQUEST');
        return;
      }
      done = true;
      if (end > CONTROL_MAX) return refuse('BAD_REQUEST');
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      } catch {
        return refuse('BAD_REQUEST');
      }
      // The token is checked before the shape: a caller without it learns nothing else.
      const given = (parsed as { token?: unknown } | null)?.token;
      if (typeof given !== 'string' || !this.tokenMatches(given)) return refuse('CALLER_DENIED');
      const request = requestSchema.safeParse(parsed);
      if (!request.success) return refuse(this.shapeError(parsed));
      void this.dispatch(request.data, socket, answer);
    });
  }

  private tokenMatches(given: string): boolean {
    const buffer = Buffer.from(given, 'utf8');
    return buffer.length === this.tokenBuffer.length && timingSafeEqual(buffer, this.tokenBuffer);
  }

  private shapeError(parsed: unknown): string {
    const op = (parsed as { op?: unknown } | null)?.op;
    return typeof op === 'string' && CONTROL_OPS.has(op) ? 'BAD_REQUEST' : 'UNKNOWN_OP';
  }

  private async dispatch(
    request: ControlRequest,
    socket: Socket,
    answer: (r: ControlResponse) => void,
  ): Promise<void> {
    if (request.op === 'approvals.watch') {
      if (!this.watchHandler) return answer({ ok: false, error: 'UNKNOWN_OP' });
      this.watches.add(socket);
      socket.setTimeout(0);
      const closers: (() => void)[] = [];
      socket.on('close', () => {
        this.watches.delete(socket);
        for (const fn of closers) fn();
      });
      this.watchHandler(
        (line) => {
          if (!socket.destroyed) socket.write(`${line}\n`);
        },
        (fn) => closers.push(fn),
      );
      return;
    }
    const handler = this.handlers[request.op];
    if (!handler) return answer({ ok: false, error: 'UNKNOWN_OP' });
    try {
      answer({ ok: true, result: (await handler(request)) ?? null });
    } catch (err) {
      answer({
        ok: false,
        error: err instanceof ControlError ? err.code : 'CONTROL_FAILED',
      });
    }
  }
}
