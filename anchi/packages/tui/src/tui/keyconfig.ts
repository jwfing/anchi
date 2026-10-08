import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { buildKeyMap, type KeyMap } from './keys.ts';

const MAX_BYTES = 64 * 1024;

/** The key bindings in `file` (defaults when it does not exist), and the problems found. */
export function loadKeyMap(file: string): { keymap: KeyMap; warnings: string[] } {
  if (!existsSync(file)) return buildKeyMap();
  let config: unknown;
  try {
    if (statSync(file).size > MAX_BYTES) throw new Error('larger than 64 KB');
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const { keymap } = buildKeyMap();
    return { keymap, warnings: [`${basename(file)} is not usable: ${(e as Error).message}`] };
  }
  return buildKeyMap(config);
}

/** Calls `onChange` with the reloaded bindings whenever `file` is created, edited or removed. */
export function watchKeyMap(
  file: string,
  onChange: (result: { keymap: KeyMap; warnings: string[] }) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  try {
    // The directory, so a file created or replaced by an editor is seen too.
    watcher = watch(dirname(file), (_event, name) => {
      if (name !== null && String(name) !== basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => onChange(loadKeyMap(file)), 100);
    });
  } catch {
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
