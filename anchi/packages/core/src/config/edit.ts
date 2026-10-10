import { Document, isMap, isNode, isScalar, parseDocument, Scalar, type YAMLMap } from 'yaml';
import type { Connector, Runtime, Workspace } from './schema.ts';

/** Where new scalar keys go: after the last of these that precede them. */
const ORDER = ['id', 'name', 'description', 'extends', 'runtime', 'model', 'effort', 'prompt'];

/** The agent settings the TUI edits directly; other fields are left as they are. */
export interface AgentPatch {
  /** An empty name, description, model or effort removes the key. */
  name?: string;
  description?: string;
  runtime?: Runtime;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | '';
  /** Written as `prompt: { mode, text: | ... }`; refused when the file names a prompt file. */
  prompt?: { mode?: 'append' | 'replace'; text?: string };
  skills?: string[];
  connectors?: Connector[];
  workspaces?: Workspace[];
  /** Set by the daemon only (removing a deleted agent); clients cannot send it. */
  delegates?: string[];
  /** Set by the daemon only (allowing a refused host); never emptied into open egress. */
  egress?: string[];
}

/**
 * Applies `patch` to an agent file's YAML, keeping its comments, order and formatting
 * elsewhere. An emptied list is removed, unless the agent extends a template whose value it
 * must then override with `[]`.
 */
export function patchAgentYaml(text: string, patch: AgentPatch): string {
  const doc: Document = text.trim() ? parseDocument(text) : new Document({});
  if (doc.errors.length) throw new Error(`invalid YAML: ${doc.errors[0]!.message}`);
  if (!isMap(doc.contents)) throw new Error('the agent file is not a YAML mapping');
  const inherits = doc.has('extends');
  // Comments belong to the replaced value; keep them on the new one.
  const replace = (path: string[], node: ReturnType<Document['createNode']>) => {
    const old = doc.getIn(path, true);
    if (isNode(old)) {
      node.comment = old.comment;
      node.commentBefore = old.commentBefore;
    }
    doc.setIn(path, node);
  };
  const set = (key: keyof AgentPatch, value: unknown[] | undefined, flow: boolean) => {
    if (value === undefined) return;
    if (!value.length && !inherits) {
      doc.delete(key);
      return;
    }
    const node = doc.createNode(value);
    if (flow) node.flow = true;
    replace([key], node);
  };
  // A new name, runtime, … goes after the keys that usually precede it, not at the end.
  const add = (key: (typeof ORDER)[number], node: ReturnType<Document['createNode']>) => {
    if (doc.has(key)) return replace([key], node);
    const root = doc.contents as YAMLMap;
    const before: string[] = ORDER.slice(0, ORDER.indexOf(key));
    let at = 0;
    root.items.forEach((p, i) => {
      if (before.includes(String(isScalar(p.key) ? p.key.value : p.key))) at = i + 1;
    });
    const pair = doc.createPair(key, node);
    const first = root.items[0]?.key;
    // The file's opening comment stays at the top.
    if (at === 0 && isNode(first) && isNode(pair.key)) {
      pair.key.commentBefore = first.commentBefore;
      first.commentBefore = undefined;
    }
    root.items.splice(at, 0, pair);
  };
  const scalar = (key: 'name' | 'description' | 'runtime' | 'model' | 'effort') => {
    const value = patch[key];
    if (value === undefined) return;
    if (value === '') doc.delete(key);
    else add(key, doc.createNode(value));
  };
  scalar('name');
  scalar('description');
  scalar('runtime');
  scalar('model');
  scalar('effort');
  if (patch.prompt) {
    if (doc.hasIn(['prompt', 'file'])) {
      throw new Error('the prompt comes from a file (prompt.file); edit that file instead');
    }
    const prompt = doc.get('prompt', true);
    // A block scalar cannot sit in a flow mapping: `prompt: { ... }` becomes a block mapping.
    if (isMap(prompt) && prompt.flow) {
      prompt.flow = false;
      // The note after `prompt: { ... } # note` goes above the block, not below it.
      if (prompt.comment && !prompt.commentBefore) {
        prompt.commentBefore = prompt.comment;
        prompt.comment = undefined;
      }
    } else if (!isMap(prompt)) add('prompt', doc.createNode({}));
    const { mode, text } = patch.prompt;
    if (mode && doc.hasIn(['prompt', 'mode'])) replace(['prompt', 'mode'], doc.createNode(mode));
    else if (mode) (doc.get('prompt') as YAMLMap).items.unshift(doc.createPair('mode', mode));
    if (text !== undefined) {
      if (!text && !inherits) doc.deleteIn(['prompt', 'text']);
      else {
        const node = new Scalar(text);
        if (text.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
        replace(['prompt', 'text'], node);
      }
    }
    const left = doc.get('prompt', true);
    if (isMap(left) && !left.items.length) doc.delete('prompt');
  }
  set('skills', patch.skills, true);
  set('connectors', patch.connectors, true);
  set('delegates', patch.delegates, true);
  // An empty egress list is not the same as none (open egress): it is always written.
  if (patch.egress !== undefined) {
    const node = doc.createNode(patch.egress);
    node.flow = true;
    replace(['egress'], node);
  }
  // `ro` is the default mode; name only when it differs from the path's last segment.
  set(
    'workspaces',
    patch.workspaces?.map((w) => ({
      path: w.path,
      ...(w.mode === 'rw' ? { mode: 'rw' } : {}),
      ...(w.name ? { name: w.name } : {}),
    })),
    false,
  );
  return doc.toString({ flowCollectionPadding: false });
}
