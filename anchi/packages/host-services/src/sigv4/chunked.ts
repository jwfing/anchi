import { createHash, createHmac } from 'node:crypto';
import { awsCredentialScope, type Headers } from '../rules/decide.ts';
import { type AwsCredential, AWS_STREAMING, EMPTY_SHA256, signingKey } from './sign.ts';

/**
 * aws-chunked uploads. The seed is re-signed like any request (the headers carry
 * x-amz-content-sha256 as given). Unsigned-chunk uploads need nothing more. Signed chunks chain
 * from the seed signature: each is recomputed with the real key as the body passes, keeping
 * its length.
 */

/** The seed signature at the end of a re-signed Authorization header (fixed length, anchored). */
const SEED_SIGNATURE = /Signature=([0-9a-f]{64})$/;
const CHUNK_LINE = /^([0-9a-fA-F]{1,8});chunk-signature=[0-9a-f]{64}$/;
const TRAILER =
  /^((?:[A-Za-z0-9-]{1,64}:[^\r\n]{0,256}\r\n){1,8})x-amz-trailer-signature:[0-9a-f]{64}\r\n\r\n$/;

/**
 * Re-signs an aws-chunked body fed in arbitrary slices; `feed(Buffer.alloc(0))` ends it.
 * Malformed or truncated input throws. Holds at most one chunk (16 MiB, S3's limit).
 */
export class ChunkResigner {
  static readonly MAX_CHUNK = 16 << 20;
  static readonly MAX_LINE = 100;
  static readonly MAX_TRAILER = 4096;
  previous: string;
  private readonly prefix: string;
  private buf = Buffer.alloc(0);
  private state: 'head' | 'data' | 'trailer' | 'end' = 'head';
  private size = 0;
  private sizeText = '';

  constructor(
    private readonly key: Buffer,
    timestamp: string,
    scope: string,
    seed: string,
    private readonly trailer: boolean,
  ) {
    this.prefix = `${timestamp}\n${scope}\n`;
    this.previous = seed;
  }

  private sign(algorithm: string, ...hashes: string[]): string {
    const text = `${algorithm}\n${this.prefix}${this.previous}\n${hashes.join('\n')}`;
    this.previous = createHmac('sha256', this.key).update(text).digest('hex');
    return this.previous;
  }

  private signChunk(chunk: Buffer): string {
    return this.sign(
      'AWS4-HMAC-SHA256-PAYLOAD',
      EMPTY_SHA256,
      createHash('sha256').update(chunk).digest('hex'),
    );
  }

  feed(data: Buffer): Buffer {
    if (!data.length) {
      if (this.state !== 'end' || this.buf.length) throw new Error('truncated aws-chunked body');
      return Buffer.alloc(0);
    }
    if (this.state === 'end') throw new Error('data after the final aws-chunked chunk');
    this.buf = Buffer.concat([this.buf, data]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.state === 'head') {
        const end = this.buf.indexOf('\r\n');
        if (end < 0) {
          if (this.buf.length > ChunkResigner.MAX_LINE)
            throw new Error('malformed aws-chunked chunk header');
          break;
        }
        const match = CHUNK_LINE.exec(this.buf.subarray(0, end).toString('latin1'));
        if (match === null) throw new Error('malformed aws-chunked chunk header');
        this.sizeText = match[1]!;
        this.size = parseInt(this.sizeText, 16);
        if (this.size > ChunkResigner.MAX_CHUNK)
          throw new Error('aws-chunked chunk larger than 16 MiB');
        this.buf = this.buf.subarray(end + 2);
        if (this.size === 0 && this.trailer) {
          out.push(
            Buffer.from(
              `${this.sizeText};chunk-signature=${this.signChunk(Buffer.alloc(0))}\r\n`,
              'latin1',
            ),
          );
          this.state = 'trailer';
        } else {
          this.state = 'data';
        }
      } else if (this.state === 'data') {
        if (this.buf.length < this.size + 2) break;
        const chunk = Buffer.from(this.buf.subarray(0, this.size));
        if (this.buf.subarray(this.size, this.size + 2).toString('latin1') !== '\r\n')
          throw new Error('malformed aws-chunked chunk');
        this.buf = this.buf.subarray(this.size + 2);
        out.push(
          Buffer.from(`${this.sizeText};chunk-signature=${this.signChunk(chunk)}\r\n`, 'latin1'),
        );
        out.push(chunk, Buffer.from('\r\n'));
        this.state = this.size ? 'head' : 'end';
      } else if (this.state === 'trailer') {
        const match = TRAILER.exec(this.buf.toString('latin1'));
        if (match === null) {
          if (this.buf.length > ChunkResigner.MAX_TRAILER)
            throw new Error('malformed aws-chunked trailer');
          break;
        }
        const lines = match[1]!;
        const signature = this.sign(
          'AWS4-HMAC-SHA256-TRAILER',
          createHash('sha256')
            .update(Buffer.from(lines.replace(/\r\n/g, '\n'), 'latin1'))
            .digest('hex'),
        );
        out.push(Buffer.from(`${lines}x-amz-trailer-signature:${signature}\r\n\r\n`, 'latin1'));
        this.buf = Buffer.alloc(0);
        this.state = 'end';
      } else {
        if (this.buf.length) throw new Error('data after the final aws-chunked chunk');
        break;
      }
    }
    return Buffer.concat(out);
  }
}

/** A ChunkResigner for re-signed `headers` whose chunks are signed, else null. */
export function awsChunkResigner(
  headers: Headers,
  credential: AwsCredential,
): ChunkResigner | null {
  const kind = AWS_STREAMING[headers['x-amz-content-sha256'] ?? ''];
  if (kind === null || kind === undefined) return null;
  const authorization = headers.authorization ?? '';
  const scope = awsCredentialScope(authorization);
  const seed = SEED_SIGNATURE.exec(authorization)?.[1];
  if (scope === null || seed === undefined) throw new Error('re-signed request has no signature');
  const { date, region, service } = scope;
  const key = signingKey(credential.secret_access_key, date, region, service);
  return new ChunkResigner(
    key,
    headers['x-amz-date']!,
    `${date}/${region}/${service}/aws4_request`,
    seed,
    kind === 'trailer',
  );
}
