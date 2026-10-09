import { Document, isMap, isNode, parseDocument } from 'yaml';
import type { Connector, Workspace } from './schema.ts';

/** The agent settings the TUI edits directly; other fields are left as they are. */
export interface AgentPatch {
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
  const set = (key: keyof AgentPatch, value: unknown[] | undefined, flow: boolean) => {
    if (value === undefined) return;
    if (!value.length && !inherits) {
      doc.delete(key);
      return;
    }
    const node = doc.createNode(value);
    if (flow) node.flow = true;
    // Comments belong to the replaced value; keep them on the new one.
    const old = doc.get(key, true);
    if (isNode(old)) {
      node.comment = old.comment;
      node.commentBefore = old.commentBefore;
    }
    doc.set(key, node);
  };
  set('skills', patch.skills, true);
  set('connectors', patch.connectors, true);
  set('delegates', patch.delegates, true);
  // An empty egress list is not the same as none (open egress): it is always written.
  if (patch.egress !== undefined) {
    const node = doc.createNode(patch.egress);
    node.flow = true;
    const old = doc.get('egress', true);
    if (isNode(old)) {
      node.comment = old.comment;
      node.commentBefore = old.commentBefore;
    }
    doc.set('egress', node);
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
