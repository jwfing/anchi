import { readdirSync } from 'node:fs';

/** Which entries a path input completes to. */
export interface PathKind {
  /** Only directories (a skill directory). */
  dirsOnly?: boolean;
  /** Files with one of these extensions, besides directories (e.g. ['.json']). */
  extensions?: string[];
}

const MAX_CANDIDATES = 200;

/**
 * Tab completion of a path typed on this computer, like a shell: the entries of the directory
 * typed so far that start with the last component. One match completes it (a directory gets its
 * `/`); several complete their common prefix and are listed. `~/` stays as typed.
 */
export function completePath(
  input: string,
  kind: PathKind = {},
  home = process.env.HOME ?? '',
): { input: string; candidates: string[] } {
  const slash = input.lastIndexOf('/');
  const dirPart = slash >= 0 ? input.slice(0, slash + 1) : input === '~' ? '~/' : '';
  const base = slash >= 0 ? input.slice(slash + 1) : input === '~' ? '' : input;
  const dir = dirPart.startsWith('~/') ? `${home}${dirPart.slice(1)}` : dirPart || '.';
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
      .map((e) => ({
        name: e.name,
        isDir: e.isDirectory() || (e.isSymbolicLink() && isDirectory(`${dir}/${e.name}`)),
      }))
      .filter(
        ({ name, isDir }) =>
          isDir ||
          (!kind.dirsOnly &&
            (!kind.extensions || kind.extensions.some((x) => name.toLowerCase().endsWith(x)))),
      )
      .map(({ name, isDir }) => (isDir ? `${name}/` : name))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
  } catch {
    return { input, candidates: [] };
  }
  if (!names.length) return { input, candidates: [] };
  if (names.length === 1) return { input: dirPart + names[0], candidates: [] };
  const common = names.reduce((p, n) => {
    let i = 0;
    while (i < p.length && p[i] === n[i]) i++;
    return p.slice(0, i);
  });
  return {
    input: dirPart + (common.length > base.length ? common : base),
    candidates: names.slice(0, MAX_CANDIDATES),
  };
}

function isDirectory(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}
