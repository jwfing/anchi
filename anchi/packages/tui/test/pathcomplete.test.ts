import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completePath } from '../src/tui/pathcomplete.ts';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'anchi-paths-'));
  mkdirSync(join(root, 'Downloads'));
  mkdirSync(join(root, 'Documents'));
  mkdirSync(join(root, '.secret'));
  writeFileSync(join(root, 'Downloads', 'client_secret_123.json'), '{}');
  writeFileSync(join(root, 'Downloads', 'notes.txt'), '');
  return root;
}

describe('path completion', () => {
  it('completes a single match, a directory with its slash', () => {
    const root = tree();
    expect(completePath(`${root}/Dow`)).toEqual({ input: `${root}/Downloads/`, candidates: [] });
    expect(completePath(`${root}/Downloads/cl`, { extensions: ['.json'] }).input).toBe(
      `${root}/Downloads/client_secret_123.json`,
    );
  });

  it('completes the common prefix and lists several matches, directories first', () => {
    const root = tree();
    expect(completePath(`${root}/Do`)).toEqual({
      input: `${root}/Do`,
      candidates: ['Documents/', 'Downloads/'],
    });
    expect(completePath(`${root}/`).candidates).toEqual(['Documents/', 'Downloads/']);
  });

  it('filters by kind, hides dot entries unless asked, and keeps ~/ as typed', () => {
    const root = tree();
    expect(completePath(`${root}/Downloads/`, { extensions: ['.json'] }).input).toBe(
      `${root}/Downloads/client_secret_123.json`,
    );
    expect(completePath(`${root}/Downloads/`, { dirsOnly: true }).candidates).toEqual([]);
    expect(completePath(`${root}/.s`).input).toBe(`${root}/.secret/`);
    expect(completePath('~/Dow', {}, root).input).toBe('~/Downloads/');
    expect(completePath('/nonexistent-anchi/x')).toEqual({
      input: '/nonexistent-anchi/x',
      candidates: [],
    });
  });
});
