import { type AwsCredential, awsResign } from '../sigv4/sign.ts';
import { apply, type Credential } from './apply.ts';
import type { Headers } from './decide.ts';
import { RULES, VERIFY_ENDPOINTS } from './table.ts';

/**
 * Connector verification: the proxy itself calls one fixed, read-only identity endpoint per
 * connector after an import, so a bad credential is reported at setup instead of as a 401 in
 * the middle of a session.
 */

export interface VerifyRequest {
  method: string;
  url: string;
  headers: Headers;
  body: Buffer;
}

/** The identity calls for `connector`, to try in order until one is not refused. */
export function verifyRequests(
  connector: string,
  credential: Credential,
  now = new Date(),
): VerifyRequest[] {
  const spec = VERIFY_ENDPOINTS[connector];
  if (!spec) throw new Error('BAD_CONNECTOR');
  const [method, urls, text] = spec;
  const body = Buffer.from(text, 'utf8');
  return urls.map((template) => {
    let url = template;
    let headers: Headers = { 'user-agent': 'anchi-egress-verify', accept: 'application/json' };
    if (connector === 'aws') {
      const aws = credential as AwsCredential;
      url = template.replace('{region}', aws.region ?? '');
      headers = { 'content-type': 'application/x-www-form-urlencoded' };
      headers = awsResign(method, url, headers, body, aws.region ?? '', 'sts', aws, now);
    } else {
      const rule = RULES.find((r) => r.grant === connector && r.kind !== 'basic');
      if (!rule) throw new Error('BAD_CONNECTOR');
      headers = apply(
        { action: 'inject', rule, op: null, reason: null },
        method,
        url,
        headers,
        body,
        credential,
      );
      if (connector === 'linear') headers['content-type'] = 'application/json';
    }
    return { method, url, headers, body };
  });
}

/** A GitHub login: letters, digits and inner hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** Characters git and a shell would read. */
const NAME_SPECIAL = new Set(['$', '%', '\\', '<', '>', '"', "'", '`']);

export interface GithubIdentity {
  github_login: string;
  github_id: number;
  github_name: string;
}

/**
 * Who the GitHub token belongs to, from `GET /user`, for commit authorship; null when the
 * response is not a usable identity. Each value is bounded: the login by its pattern, the id as
 * an integer, the name to printable characters.
 */
export function githubIdentity(status: number, body: Buffer): GithubIdentity | null {
  if (status !== 200) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { login, id, name } = data as { login?: unknown; id?: unknown; name?: unknown };
  if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) return null;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || id >= 2 ** 53) return null;
  let clean = '';
  if (typeof name === 'string') {
    const kept = [...name.slice(0, 1000)]
      .map((c) => (NAME_SPECIAL.has(c) || /\p{C}/u.test(c) ? ' ' : c))
      .join('');
    clean = kept.split(/\s+/).filter(Boolean).join(' ').slice(0, 100).trim();
  }
  return { github_login: login, github_id: id, github_name: clean || login };
}

export class VerifyError extends Error {}

/** Account label from the identity call's response; VerifyError when the credential is refused. */
export function verifyAccount(connector: string, status: number, body: Buffer, url = ''): string {
  if (status === 401 || status === 403) throw new VerifyError('CREDENTIAL_REJECTED');
  if (status !== 200) throw new VerifyError(`VERIFY_HTTP_${status}`);
  const text = body.toString('utf8');
  const parse = (): unknown => JSON.parse(text);
  try {
    if (connector === 'github') return String(field(parse(), 'login')).slice(0, 100);
    if (connector === 'posthog') {
      const region = url.startsWith('https://eu.') ? 'EU' : 'US';
      return `${String(field(parse(), 'email')).slice(0, 90)} (${region})`;
    }
    if (connector === 'sentry') {
      const list = parse();
      if (!Array.isArray(list)) throw new TypeError();
      const slugs = list.slice(0, 3).map((o) => String(field(o, 'slug')).slice(0, 40));
      if (!slugs.length) throw new VerifyError('CREDENTIAL_REJECTED');
      return slugs.join(', ').slice(0, 100);
    }
    if (connector === 'firecrawl') {
      const credits = field(field(parse(), 'data'), 'remainingCredits');
      if (typeof credits !== 'number' || !Number.isInteger(credits)) throw new TypeError();
      return `team with ${credits} credits left`;
    }
    if (connector === 'figma') {
      const data = parse() as Record<string, unknown>;
      return String(data.email || field(data, 'handle')).slice(0, 100);
    }
    if (connector === 'discord') return String(field(parse(), 'username')).slice(0, 100);
    if (connector === 'linear') {
      const data = parse() as { errors?: unknown; data?: { viewer?: Record<string, unknown> } };
      if (data.errors) throw new VerifyError('CREDENTIAL_REJECTED');
      const viewer = field(field(data, 'data'), 'viewer') as Record<string, unknown>;
      return String(viewer.email || viewer.name).slice(0, 100);
    }
    const arn = /<Arn>([^<]{1,300})<\/Arn>/.exec(text);
    if (arn) return arn[1]!;
  } catch (err) {
    if (err instanceof VerifyError) throw err;
  }
  throw new VerifyError('VERIFY_UNEXPECTED_RESPONSE');
}

/** `value[key]`, throwing like Python's `[]` on a missing key or a non-object. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  if (!(key in value)) throw new TypeError();
  const found = (value as Record<string, unknown>)[key];
  if (found === undefined) throw new TypeError();
  return found;
}
