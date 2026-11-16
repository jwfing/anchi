import type { Decision } from './decide.ts';
import { HIGH_RISK } from './table.ts';
import { graphqlMutationNames } from './writes.ts';

/** Git pkt-line parsing of a push's ref updates, on latin1 strings (one char per byte). */
const GIT_OID = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
export const GIT_UPDATE = new RegExp(`(${GIT_OID}) (${GIT_OID}) (refs/[^\\x00\\s]{1,200})`);
const GIT_UPDATE_FULL = new RegExp(`^${GIT_UPDATE.source}$`);
const GIT_UPDATE_ALL = new RegExp(GIT_UPDATE.source, 'g');
const GIT_SHALLOW = new RegExp(`^shallow ${GIT_OID}\\n?$`);
const GIT_PKT_LEN = /^[0-9a-fA-F]{4}$/;
/** The ref updates of a push precede its pack; longer lists are not read, and the push is high-risk. */
export const GIT_COMMANDS_MAX = 65536;

export type RefUpdate = [old: string, now: string, ref: string];

export class GitPushError extends Error {}

/**
 * The ref updates at the start of a git-receive-pack body, as [updates, capabilities], or null
 * while the list has not ended. Throws GitPushError if the list is malformed or longer than
 * GIT_COMMANDS_MAX bytes.
 */
export function gitPushCommands(body: Buffer): [RefUpdate[], Set<string>] | null {
  const text = body.toString('latin1');
  let pos = 0;
  const updates: RefUpdate[] = [];
  let caps = new Set<string>();
  for (;;) {
    if (pos + 4 > text.length) {
      if (pos + 4 > GIT_COMMANDS_MAX)
        throw new GitPushError('the ref updates are too long to read');
      return null;
    }
    const head = text.slice(pos, pos + 4);
    if (!GIT_PKT_LEN.test(head)) throw new GitPushError('not a git push');
    const size = parseInt(head, 16);
    if (size === 0) return [updates, caps];
    if (size < 5 || pos + size > GIT_COMMANDS_MAX)
      throw new GitPushError('the ref updates are too long to read');
    if (pos + size > text.length) return null;
    const line = text.slice(pos + 4, pos + size);
    pos += size;
    if (GIT_SHALLOW.test(line)) continue;
    const nul = line.indexOf('\0');
    const command = nul === -1 ? line : line.slice(0, nul);
    const capabilities = nul === -1 ? '' : line.slice(nul + 1);
    const match = GIT_UPDATE_FULL.exec(command.replace(/\n$/, ''));
    if (match === null) throw new GitPushError('not a ref update');
    if (!updates.length) caps = new Set(capabilities.split(/\s+/).filter(Boolean));
    updates.push([match[1]!, match[2]!, match[3]!]);
  }
}

export function gitUpdateSubject(old: string, now: string, ref: string): string {
  return (/^0+$/.test(now) ? 'delete ' : 'update ') + ref;
}

/** The refs a push body updates, for the approval summary (bounded to the first 64 KiB). */
export function gitPushRefs(body: Buffer): string[] {
  const text = body.subarray(0, 65536).toString('latin1');
  return [...text.matchAll(GIT_UPDATE_ALL)].map((m) => m[3]!);
}

/** [id, description] of the first high-risk entry this injected request matches, or null. */
export function highRisk(
  d: Decision,
  method: string,
  path: string,
  body: Buffer,
  disabled: ReadonlySet<string> | readonly string[] = [],
): [string, string] | null {
  const rule = d.rule;
  if (rule === null) return null;
  const off = new Set(disabled);
  let subjects: string[];
  if (rule.name === 'github-git') {
    if (!path.split('?', 1)[0]!.endsWith('/git-receive-pack')) return null;
    let parsed: [RefUpdate[], Set<string>] | null;
    try {
      parsed = gitPushCommands(body);
    } catch {
      parsed = null;
    }
    // A push whose ref updates cannot be read could update anything.
    if (parsed === null)
      return ['github-push-unreadable', 'a push whose ref updates cannot be read'];
    subjects = parsed[0].map((u) => gitUpdateSubject(...u));
  } else if (rule.name === 'github-api' && path.split('?', 1)[0] === '/graphql') {
    const names = graphqlMutationNames(body);
    // A document that cannot be read could hold any mutation, like an unreadable push.
    if (names === 'unreadable')
      return ['github-graphql-unreadable', 'a GraphQL request whose document cannot be read'];
    subjects = [`graphql-mutation:${names}`];
  } else {
    subjects = [d.op ?? ''];
  }
  for (const [id, ruleName, pattern, text] of HIGH_RISK) {
    if (ruleName !== rule.name || off.has(id)) continue;
    if (subjects.some((s) => pattern.test(s))) return [id, text];
  }
  return null;
}

/** What the user approves: the git refs a push updates, or the start of the request body. */
export function writeSummary(d: Decision, method: string, path: string, body: Buffer): string {
  if (d.rule?.name === 'github-git') {
    const refs = gitPushRefs(body);
    return `git push: ${refs.length ? refs.join(', ') : 'no ref updates found'}`;
  }
  if (!body.length) return `${method} ${path.slice(0, 300)}`;
  if (body.subarray(0, 4096).includes(0))
    return `${method} ${path.slice(0, 300)} (binary body, ${body.length} bytes)`;
  return `${method} ${path.slice(0, 300)}\n${body.subarray(0, 2000).toString('utf8')}`;
}
