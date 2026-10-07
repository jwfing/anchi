/**
 * Newline-delimited JSON with a hard frame limit. Every socket and pipe in Anchi uses it,
 * including the cell runner's stdout, which is untrusted: a frame over the limit or a line
 * that is not JSON is a protocol error, never skipped silently.
 */

/** Client ⇄ daemon frames: whole sessions of stored events can be returned. */
export const CLIENT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Cell runner → daemon frames. Runtime output is truncated in the cell well below this. */
export const CELL_MAX_FRAME_BYTES = 256 * 1024;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Splits a byte stream into JSON frames. After the first error the decoder stops: the
 * caller is expected to close the connection.
 */
export class FrameDecoder {
  private parts: Buffer[] = [];
  private size = 0;
  private failed = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onFrame: (value: unknown) => void,
    private readonly onError: (err: ProtocolError) => void,
  ) {}

  push(chunk: Buffer | string): void {
    if (this.failed) return;
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        this.size += buf.length;
        if (this.size > this.maxBytes) return this.fail(`frame exceeds ${this.maxBytes} bytes`);
        if (buf.length) this.parts.push(buf);
        return;
      }
      this.size += nl;
      if (this.size > this.maxBytes) return this.fail(`frame exceeds ${this.maxBytes} bytes`);
      const line = Buffer.concat([...this.parts, buf.subarray(0, nl)]).toString('utf8');
      this.parts = [];
      this.size = 0;
      buf = buf.subarray(nl + 1);
      if (line.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return this.fail('frame is not valid JSON');
        }
        this.onFrame(value);
        if (this.failed) return;
      }
    }
  }

  /** Stops decoding; later chunks are ignored. */
  fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.parts = [];
    this.onError(new ProtocolError(message));
  }
}
