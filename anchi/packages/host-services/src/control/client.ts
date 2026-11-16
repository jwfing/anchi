import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { CONTROL_MAX, type ControlInput, type ControlResponse } from './protocol.ts';

/** A request without the token, member by member (a plain Omit would merge the union). */
export type ClientRequest = ControlInput extends infer R
  ? R extends { token: string }
    ? Omit<R, 'token'>
    : never
  : never;

/**
 * The daemon's side of the control socket: one request per connection, the token read from
 * the file beside the socket each time (the process writes a new one when it starts).
 */
export class ControlClient {
  constructor(
    readonly socketPath: string,
    readonly tokenPath: string,
  ) {}

  private token(): string {
    return readFileSync(this.tokenPath, 'utf8').trim();
  }

  /** The answer's `result`; a refusal becomes an Error whose message is the code. */
  call(request: ClientRequest, timeoutMs = 40_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let token: string;
      try {
        token = this.token();
      } catch (err) {
        return reject(new Error(`HOST_SERVICES_UNAVAILABLE: ${(err as Error).message}`));
      }
      const socket = connect(this.socketPath);
      let data = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        socket.destroy();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('CONTROL_TIMEOUT'))), timeoutMs);
      socket.on('error', (err) =>
        finish(() => reject(new Error(`HOST_SERVICES_UNAVAILABLE: ${err.message}`))),
      );
      socket.on('connect', () => socket.write(`${JSON.stringify({ ...request, token })}\n`));
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.length > CONTROL_MAX * 64) finish(() => reject(new Error('CONTROL_OVERSIZE')));
      });
      socket.on('close', () =>
        finish(() => {
          const line = data.split('\n')[0] ?? '';
          let response: ControlResponse;
          try {
            response = JSON.parse(line) as ControlResponse;
          } catch {
            return reject(new Error('HOST_SERVICES_UNAVAILABLE: no answer'));
          }
          if (response.ok) resolve(response.result);
          else reject(new Error(response.error));
        }),
      );
    });
  }

  /**
   * Opens `approvals.watch`: `onLine` gets each event line, `onClose` the end of the stream.
   * Returns a function that closes it.
   */
  watch(onLine: (line: string) => void, onClose: () => void): () => void {
    let socket: Socket;
    try {
      const token = this.token();
      socket = connect(this.socketPath);
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ op: 'approvals.watch', token })}\n`),
      );
    } catch {
      setTimeout(onClose, 0);
      return () => {};
    }
    socket.on('error', () => {});
    socket.on('close', onClose);
    createInterface({ input: socket }).on('line', onLine);
    return () => socket.destroy();
  }
}
