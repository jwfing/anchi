import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import type { Headers } from '../rules/decide.ts';
import { publicAddress } from '../rules/address.ts';

/** `host` resolved once and checked: the proxy connects to this address, never resolves again. */
export async function resolvePublic(
  host: string,
): Promise<{ address: string | null; reason: string | null }> {
  // An IP literal is checked as it is.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    const [address, reason] = publicAddress([
      { family: host.includes(':') ? 6 : 4, address: host },
    ]);
    return { address, reason };
  }
  let infos: { address: string; family: number }[];
  try {
    infos = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return { address: null, reason: `cannot resolve ${host}: ${(err as Error).message}` };
  }
  const [address, reason] = publicAddress(
    infos.map((i) => ({ family: i.family as 4 | 6, address: i.address })),
  );
  return { address, reason };
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: IncomingMessage;
}

/**
 * One request to `address` (already checked) for `host`, over TLS unless `insecure`, with the
 * request's body given whole or streamed. The caller owns the response stream.
 */
export function upstreamRequest(options: {
  address: string;
  host: string;
  port: number;
  tls: boolean;
  method: string;
  path: string;
  headers: Headers;
  body: Buffer | Readable | null;
  timeoutMs?: number;
  /** An extra trusted CA (tests); the system's roots otherwise. */
  ca?: string;
}): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const make = options.tls ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { ...options.headers };
    delete headers.connection;
    delete headers['proxy-connection'];
    delete headers['keep-alive'];
    const req = make({
      host: options.address,
      port: options.port,
      servername: options.tls ? options.host : undefined,
      method: options.method,
      path: options.path,
      headers,
      setHost: false,
      timeout: options.timeoutMs ?? 120_000,
      ...(options.ca ? { ca: options.ca } : {}),
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.on('response', (res) =>
      resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res }),
    );
    if (options.body === null) req.end();
    else if (Buffer.isBuffer(options.body)) req.end(options.body);
    else options.body.pipe(req);
  });
}

/** Reads a response body up to `limit` bytes. */
export function readBody(stream: Readable, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
