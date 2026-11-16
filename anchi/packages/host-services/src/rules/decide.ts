import { createHash } from 'node:crypto';
import {
  PLACEHOLDER_AWS_KEY,
  PLACEHOLDER_COMPACT,
  PLACEHOLDER_MARK,
  type Rule,
  RULES,
  S3_SUBRESOURCES,
} from './table.ts';

/** Request headers with lowercase names, one value each (as the Python proxy saw them). */
export type Headers = Record<string, string>;

export interface Decision {
  /** pass | inject | deny */
  action: 'pass' | 'inject' | 'deny';
  rule: Rule | null;
  op: string | null;
  reason: string | null;
}

const decision = (
  action: Decision['action'],
  rule: Rule | null = null,
  op: string | null = null,
  reason: string | null = null,
): Decision => ({ action, rule, op, reason });

export function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
  return h === pattern;
}

export function findRule(host: string, extra: readonly Rule[] = []): Rule | null {
  for (const rule of [...RULES, ...extra]) {
    if (rule.hosts.some((p) => hostMatches(p, host))) return rule;
  }
  return null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The rule for a user's OpenAI-compatible endpoint, which only the vault knows. Its host never
 * has a built-in rule, so it cannot shadow one. The key is injected under the base URL's path
 * only; anything else on that host is left as the session sent it, placeholder and all.
 */
export function hermesRule(host: string, basePath = ''): Rule {
  const prefix = basePath.replace(/\/+$/, '');
  return {
    name: 'hermes',
    hosts: [host],
    kind: 'bearer',
    grant: 'hermes',
    replaceOnly: true,
    ...(prefix ? { path: new RegExp(`^${escapeRegExp(prefix)}(/|$)`) } : {}),
    // OpenAI-style administration (organization, projects, API keys) is not an agent's business.
    deny: [/^\S+ (\/[^ ]*)?\/(organization|organizations|dashboard)(\/|$)/i],
  };
}

/** What kind of credential the client sent, without revealing it. */
export function classifyCredential(headers: Headers): 'none' | 'placeholder' | 'other' {
  const auth = headers.authorization || headers['x-api-key'] || headers['x-figma-token'] || '';
  if (!auth) return 'none';
  if (
    auth.includes(PLACEHOLDER_MARK) ||
    auth.includes(PLACEHOLDER_COMPACT) ||
    auth.includes(PLACEHOLDER_AWS_KEY)
  )
    return 'placeholder';
  if (auth.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      if (decoded.includes(PLACEHOLDER_MARK)) return 'placeholder';
    } catch {
      // Not base64: a credential of the client's own.
    }
  }
  return 'other';
}

const AWS_SCOPE = /Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/;

export function awsScope(headers: Headers): [string, string] | null {
  const match = AWS_SCOPE.exec(headers.authorization ?? '');
  return match ? [match[1]!, match[2]!] : null;
}

/** The first value of `key` in a query string, as Python's parse_qs returns it (blank dropped). */
function queryValue(query: string, key: string, keepBlank = false): string | null {
  for (const [k, v] of new URLSearchParams(query)) {
    if (k === key && (keepBlank || v !== '')) return v;
  }
  return null;
}

export function awsOperation(
  service: string,
  headers: Headers,
  body: Buffer,
  method: string,
  path: string,
): string {
  const target = headers['x-amz-target'];
  if (target) return `${service}:${target.split('.').at(-1)}`;
  if ((headers['content-type'] ?? '').includes('x-www-form-urlencoded')) {
    const action = queryValue(body.toString('utf8'), 'Action');
    if (action) return `${service}:${action}`;
  }
  const question = path.indexOf('?');
  if (question !== -1) {
    const action = queryValue(path.slice(question + 1), 'Action');
    if (action) return `${service}:${action}`;
  }
  const clean = question === -1 ? path : path.slice(0, question);
  if (service === 's3' && question !== -1) {
    // Subresources decide what an S3 call does: `POST /b?delete` deletes objects.
    const keys = new Set([...new URLSearchParams(path.slice(question + 1)).keys()]);
    const sub = S3_SUBRESOURCES.find((k) => keys.has(k));
    if (sub) return `${service}:${method} ${clean}?${sub}`;
  }
  return `${service}:${method} ${clean}`;
}

/** Field names in a GraphQL document, unique, in order: `name(` or `name{`. */
export function graphqlNames(document: string): string[] {
  const names = new Set<string>();
  for (const match of document.matchAll(/\b([a-z][A-Za-z]+)\s*[({]/g)) names.add(match[1]!);
  return [...names];
}

export function operation(
  rule: Rule,
  method: string,
  path: string,
  headers: Headers,
  body: Buffer,
): string {
  if (rule.kind === 'aws_sigv4') {
    const scope = awsScope(headers);
    return awsOperation(scope ? scope[1] : 'unknown', headers, body, method, path);
  }
  if (rule.name === 'linear') {
    // GraphQL: the operation is in the body. Bounded so the audit log stays small.
    let query = '';
    try {
      const parsed: unknown = JSON.parse(body.length ? body.toString('utf8') : '{}');
      const q = (parsed as { query?: unknown } | null)?.query;
      if (typeof q === 'string') query = q;
    } catch {
      query = '';
    }
    return `graphql:${graphqlNames(query).join(',').slice(0, 300)}`;
  }
  return `${method} ${path.split('?', 1)[0]}`;
}

/**
 * `headers` has lowercase keys. `grants` holds the session's connectors (and a cell's runtime);
 * `extra` holds rules that depend on stored settings (the Hermes endpoint).
 */
export function decide(
  method: string,
  host: string,
  path: string,
  headers: Headers = {},
  body: Buffer = Buffer.alloc(0),
  grants: ReadonlySet<string> | readonly string[] = [],
  extra: readonly Rule[] = [],
): Decision {
  const granted = new Set(grants);
  const rule = findRule(host, extra);
  if (rule === null) return decision('pass');
  const cleanPath = path.split('?', 1)[0]!;
  if (rule.path && !rule.path.test(cleanPath)) return decision('pass');
  if (rule.grant !== null && !granted.has(rule.grant)) {
    // No connector, no injection. The request leaves with whatever the client sent.
    return decision('pass', rule, null, 'not-granted');
  }
  // AWS: only SigV4-signed calls are re-signed; unsigned public downloads pass through.
  if (rule.kind === 'aws_sigv4' && awsScope(headers) === null)
    return decision('pass', rule, null, 'unsigned');
  const op = operation(rule, method, path, headers, body);
  if (rule.deny.some((p) => p.test(op))) return decision('deny', rule, op);
  if (rule.kind === 'none') return decision('pass', rule, op);
  if (rule.replaceOnly && classifyCredential(headers) !== 'placeholder')
    return decision('pass', rule, op, 'no-placeholder');
  return decision('inject', rule, op);
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * (status, body, headers) for a denial, in the service's own error shape for AWS so SDKs
 * surface it cleanly and do not treat it as a retryable parse failure.
 */
export function denyResponse(
  d: Decision,
  headers: Headers,
): { status: number; body: Buffer; headers: Headers } {
  const message = `anchi: ${d.op} denied`;
  if (d.rule?.kind === 'aws_sigv4') {
    if (headers['x-amz-target']) {
      return {
        status: 403,
        // Spaced as Python's json.dumps writes it, so the two proxies answer byte for byte alike.
        body: Buffer.from(
          `{"__type": "AccessDeniedException", "message": ${JSON.stringify(message)}}`,
        ),
        headers: { 'content-type': 'application/x-amz-json-1.1' },
      };
    }
    return {
      status: 403,
      body: Buffer.from(
        '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code>' +
          `<Message>${escapeXml(message)}</Message></Error><RequestId>anchi</RequestId></ErrorResponse>`,
      ),
      headers: { 'content-type': 'text/xml' },
    };
  }
  return {
    status: 403,
    body: Buffer.from(`${message}\n`),
    headers: { 'content-type': 'text/plain' },
  };
}

export const sha256hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');
