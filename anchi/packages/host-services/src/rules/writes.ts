import type { Decision } from './decide.ts';
import { graphqlNames } from './decide.ts';

/**
 * Writes held for approval. With a connector in the session's `ask` list, an injected request
 * that changes something waits for the user. Reads are never held: they would make `ask`
 * unusable, and the boundary (no credential in the session) does not depend on them.
 */

const AWS_READ =
  /^[a-z0-9-]+:(Get|List|Describe|Filter|Search|Lookup|Head|Query|Scan|BatchGet|Select|Check|Validate|Estimate|Preview|Simulate|Test|View|Download|StartQuery|StopQuery)/;
export const REST_CONNECTORS = ['posthog', 'sentry', 'firecrawl', 'figma', 'discord'] as const;
// PostHog runs HogQL and insight queries as POST; they read.
const POSTHOG_QUERY = /^\/api\/(projects|environments)\/[^/]+\/query\/?$/;
export const GRAPHQL_MAX_DOCUMENT = 1_000_000;

/**
 * The document with its comments and string literals blanked, so a `mutation` keyword is
 * found only where GraphQL reads one, and one inside a string or comment is not.
 */
export function graphqlStrip(document: string): string {
  const out: string[] = [];
  const n = document.length;
  let i = 0;
  while (i < n) {
    const c = document[i]!;
    if (c === '#') {
      while (i < n && document[i] !== '\r' && document[i] !== '\n') i++;
      continue;
    }
    if (document.startsWith('"""', i)) {
      let j = document.indexOf('"""', i + 3);
      while (j !== -1 && document[j - 1] === '\\') j = document.indexOf('"""', j + 1);
      i = j === -1 ? n : j + 3;
      out.push(' ');
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && document[i] !== '"' && document[i] !== '\n')
        i += document[i] === '\\' ? 2 : 1;
      i++;
      out.push(' ');
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * The GraphQL document of a request body, stripped, or null when the body is not a readable
 * GraphQL request: the proxy then treats it as a write.
 */
export function graphqlDocument(body: Buffer): string | null {
  let request: unknown;
  try {
    request = JSON.parse(body.length ? body.toString('utf8') : '{}');
  } catch {
    return null;
  }
  const query =
    request && typeof request === 'object' && !Array.isArray(request)
      ? (request as { query?: unknown }).query
      : undefined;
  if (typeof query !== 'string' || !query.trim() || query.length > GRAPHQL_MAX_DOCUMENT)
    return null;
  return graphqlStrip(query.replace(/^﻿+/, ''));
}

/**
 * Whether a GraphQL request carries a mutation. Comments, a byte-order mark, commas and other
 * operations may precede it, so the keyword counts anywhere at the top level of the document;
 * a document that holds a mutation beside a query is a write whichever operation is named.
 * Unreadable requests count as writes too.
 */
export function graphqlMutation(body: Buffer): boolean {
  const document = graphqlDocument(body);
  if (document === null) return true;
  let depth = 0;
  for (const match of document.matchAll(/[(){}]|\b(query|mutation|subscription|fragment)\b/g)) {
    const token = match[0];
    if (token === '(' || token === '{') depth++;
    else if (token === ')' || token === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && token === 'mutation') return true;
  }
  return false;
}

/** Whether an injected request changes state upstream (git push, API writes, mutations). */
export function isWrite(d: Decision, method: string, path: string, body: Buffer): boolean {
  const rule = d.rule;
  const clean = path.split('?', 1)[0]!;
  if (rule === null) return false;
  if (rule.name === 'github-git') return clean.endsWith('/git-receive-pack');
  if (rule.name === 'github-api') {
    if (clean === '/graphql') return graphqlMutation(body);
    return !['GET', 'HEAD', 'OPTIONS'].includes(method);
  }
  if (rule.name === 'linear') return graphqlMutation(body);
  if (rule.kind === 'aws_sigv4') {
    const op = d.op ?? '';
    const rest = op.includes(':') ? op.slice(op.indexOf(':') + 1) : '';
    // REST, such as S3: by method.
    if (op.includes(':') && rest.includes(' '))
      return !(rest.startsWith('GET ') || rest.startsWith('HEAD '));
    return !AWS_READ.test(op);
  }
  if ((REST_CONNECTORS as readonly string[]).includes(rule.name)) {
    if (rule.name === 'posthog' && method === 'POST' && POSTHOG_QUERY.test(clean)) return false;
    // Firecrawl's scrapes, crawls and searches spend credits, so they count as writes too.
    return !['GET', 'HEAD', 'OPTIONS'].includes(method);
  }
  return false;
}

/**
 * Field names of a request that carries a mutation (every selection in the document, so a
 * high-risk operation is found wherever it sits), or '' for a request without one.
 */
export function graphqlMutationNames(body: Buffer): string {
  if (!graphqlMutation(body)) return '';
  const document = graphqlDocument(body);
  if (document === null) return 'unreadable';
  return graphqlNames(document).join(',');
}
