import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Writable workspaces are directories of the Mac. The cell masks the code-running paths that
 * exist when it starts; this audit finds what a turn added anyway, by comparing the workspace
 * before and after the turn on the Mac itself. It reports; it never changes files.
 */

const MAX_ENTRIES = 50_000;
const SKIP_DIRS = new Set(['node_modules', 'objects', 'logs', '.cache']);
const WATCHED_FILES = new Set([
  '.envrc',
  '.gitattributes',
  'tasks.json',
  'launch.json',
  'settings.json',
]);
/** Git configuration keys whose values git (or a tool reading the config) runs as commands. */
const RISKY_GIT_KEYS =
  /^\s*(fsmonitor|hookspath|sshcommand|pager|editor|askpass|helper|command|clean|smudge|process|textconv|external|program|cmd|gpgprogram)\s*=/i;

interface Entry {
  kind: 'file' | 'link' | 'dir';
  mode: number;
  hash?: string;
  target?: string;
}
export type Snapshot = Map<string, Entry>;

/** What a turn might have planted: git config, hooks, links, executables, editor config. */
function interesting(rel: string, st: Stats): boolean {
  const parts = rel.split(sep);
  const base = parts.at(-1)!;
  if (st.isSymbolicLink()) return true;
  if (parts.includes('.git')) {
    const i = parts.indexOf('.git');
    return (
      parts[i + 1] === 'config' ||
      parts[i + 1] === 'hooks' ||
      parts[i + 1] === 'info' ||
      base === 'config'
    );
  }
  if (st.isFile() && st.mode & 0o111) return true;
  return WATCHED_FILES.has(base) && (base !== 'tasks.json' || parts.includes('.vscode'));
}

export function snapshot(root: string): Snapshot {
  const snap: Snapshot = new Map();
  let seen = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return;
      const path = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      const rel = relative(root, path);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path);
        continue;
      }
      if (!interesting(rel, st)) continue;
      if (st.isSymbolicLink()) {
        snap.set(rel, { kind: 'link', mode: st.mode, target: readlinkSync(path) });
      } else if (st.isFile() && st.size <= 1 << 20) {
        snap.set(rel, {
          kind: 'file',
          mode: st.mode,
          hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
        });
      }
    }
  };
  walk(root);
  return snap;
}

/** Findings for the transcript: one line each, paths relative to the workspace. */
export function audit(root: string, before: Snapshot, after: Snapshot): string[] {
  const findings: string[] = [];
  for (const [rel, entry] of after) {
    const old = before.get(rel);
    const changed = !old || old.hash !== entry.hash || old.target !== entry.target;
    const parts = rel.split(sep);
    if (entry.kind === 'link') {
      if (!changed) continue;
      const target = isAbsolute(entry.target!)
        ? entry.target!
        : resolve(dirname(join(root, rel)), entry.target!);
      if (target !== root && !target.startsWith(root + sep)) {
        findings.push(`${rel}: symlink to ${entry.target} (outside the workspace)`);
      }
      continue;
    }
    if (parts.includes('.git') && parts.includes('hooks')) {
      if (changed && !rel.endsWith('.sample')) findings.push(`${rel}: git hook added or changed`);
      continue;
    }
    if (parts.includes('.git') && parts.at(-1) === 'config') {
      if (!changed) continue;
      const keys = readLines(join(root, rel)).filter(
        (l) => RISKY_GIT_KEYS.test(l) || /^\s*!/.test(l.split('=')[1] ?? ''),
      );
      if (keys.length)
        findings.push(
          `${rel}: git config runs commands (${keys.map((k) => k.trim().split(/\s*=/)[0]).join(', ')})`,
        );
      continue;
    }
    if (entry.mode & 0o111 && !(old && old.mode & 0o111)) {
      findings.push(`${rel}: new executable file`);
      continue;
    }
    if (changed && !(entry.mode & 0o111)) findings.push(`${rel}: ${old ? 'changed' : 'added'}`);
  }
  return findings;
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
}
