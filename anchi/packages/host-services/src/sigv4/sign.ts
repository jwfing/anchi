import { createHash, createHmac } from 'node:crypto';
import type { Headers } from '../rules/decide.ts';

/**
 * AWS Signature Version 4 as botocore's SigV4Auth computes it for an AWSRequest built from a
 * URL and headers (the Python proxy's `aws_resign`): the same canonical request, so the
 * fixtures scripts/gen-egress-fixtures.py takes from botocore must match here.
 */

export interface AwsCredential {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string | null;
  region?: string;
}

/** Signed with the placeholder and recomputed, or proxy/hop-by-hop headers that must not be signed. */
export const AWS_STRIP = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-security-token',
  'proxy-connection',
  'connection',
]);
const UNSIGNED_HEADERS = new Set(['expect', 'user-agent', 'x-amzn-trace-id']);
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
export const AWS_STREAMING: Record<string, 'chunks' | 'trailer' | null> = {
  'STREAMING-UNSIGNED-PAYLOAD-TRAILER': null,
  'STREAMING-AWS4-HMAC-SHA256-PAYLOAD': 'chunks',
  'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER': 'trailer',
};

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** `YYYYMMDDTHHMMSSZ` of a date. */
export function amzDate(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** The parts of an absolute URL as Python's urlsplit sees them: nothing decoded or resolved. */
export function splitUrl(url: string): { host: string; path: string; query: string } {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(url);
  if (!match) throw new Error('BAD_URL');
  return { host: match[1]!, path: match[2]!, query: match[3] ?? '' };
}

/** botocore's remove_dot_segments: `.` and `..` resolved, empty segments dropped. */
export function normalizePath(path: string): string {
  if (!path) return '/';
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  const first = path.startsWith('/') ? '/' : '';
  const last = path.endsWith('/') && out.length ? '/' : '';
  return `${first}${out.join('/')}${last}`;
}

/** Python's `quote(s, safe='/~')`: percent-encodes everything but unreserved characters. */
function quotePath(text: string): string {
  return Buffer.from(text, 'utf8')
    .toJSON()
    .data.map((byte) => {
      const c = String.fromCharCode(byte);
      return /[A-Za-z0-9_.\-/~]/.test(c)
        ? c
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/** botocore's canonical query string of a URL: pairs sorted as given, nothing re-encoded. */
export function canonicalQuery(query: string): string {
  if (!query) return '';
  const pairs = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    return eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
  });
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort((a, b) => compare(a[0]!, b[0]!) || compare(a[1]!, b[1]!));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  let key: Buffer = Buffer.from(`AWS4${secret}`, 'utf8');
  for (const part of [date, region, service, 'aws4_request']) key = hmac(key, part);
  return key;
}

/**
 * New headers (lowercase keys) for `method url` signed with `credential` for `service` in
 * `region`: the request's own headers except AWS_STRIP, plus `x-amz-date`, the session token
 * and the `authorization`. A precomputed `x-amz-content-sha256` is signed as given, else the
 * body is hashed; unknown streaming payload kinds are refused.
 */
export function awsResign(
  method: string,
  url: string,
  headers: Headers,
  body: Buffer,
  region: string,
  service: string,
  credential: AwsCredential,
  now = new Date(),
): Headers {
  const payload = headers['x-amz-content-sha256'] ?? '';
  if (payload.startsWith('STREAMING-') && !(payload in AWS_STREAMING))
    throw new Error(`${payload.slice(0, 60)} payloads are not re-signed`);
  const out: Headers = {};
  for (const [k, v] of Object.entries(headers))
    if (!AWS_STRIP.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  const timestamp = amzDate(now);
  out['x-amz-date'] = timestamp;
  if (credential.session_token) out['x-amz-security-token'] = credential.session_token;
  const parts = splitUrl(url);
  const toSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(out)) if (!UNSIGNED_HEADERS.has(k)) toSign[k] = v;
  if (!('host' in toSign)) toSign.host = parts.host;
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names
    .map((k) => `${k}:${toSign[k]!.trim().split(/\s+/).join(' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const payloadHash =
    'x-amz-content-sha256' in out
      ? out['x-amz-content-sha256']!
      : body.length
        ? sha256(body)
        : EMPTY_SHA256;
  const canonical = [
    method.toUpperCase(),
    quotePath(normalizePath(parts.path)),
    canonicalQuery(parts.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`;
  const signature = createHmac(
    'sha256',
    signingKey(credential.secret_access_key, date, region, service),
  )
    .update(stringToSign)
    .digest('hex');
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credential.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
