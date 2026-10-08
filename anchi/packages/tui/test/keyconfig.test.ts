import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKeyMap, watchKeyMap } from '../src/tui/keyconfig.ts';
import { KEYS_TEMPLATE } from '../src/tui/keys.ts';

describe('keybindings.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchi-keys-'));
  const file = join(dir, 'keybindings.json');
  afterEach(() => rmSync(file, { force: true }));

  it('uses the defaults without a file, and says why a file is unusable', () => {
    expect(loadKeyMap(file)).toMatchObject({ warnings: [] });
    writeFileSync(file, '{ not json');
    const { keymap, warnings } = loadKeyMap(file);
    expect(keymap.leader).toBe('ctrl+x');
    expect(warnings[0]).toMatch(/keybindings.json is not usable/);
    writeFileSync(file, 'x'.repeat(70_000));
    expect(loadKeyMap(file).warnings[0]).toMatch(/64 KB/);
  });

  it('applies the template cleanly', () => {
    writeFileSync(file, KEYS_TEMPLATE);
    const { keymap, warnings } = loadKeyMap(file);
    expect(warnings).toEqual([]);
    expect(keymap.contexts.global.get('ctrl+n')).toBeUndefined();
  });

  it('reloads when the file changes', async () => {
    const seen: string[] = [];
    const stop = watchKeyMap(file, (r) => seen.push(r.keymap.leader));
    writeFileSync(file, JSON.stringify({ leader: 'ctrl+g' }));
    for (let i = 0; i < 50 && !seen.includes('ctrl+g'); i++)
      await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(seen).toContain('ctrl+g');
  });
});
