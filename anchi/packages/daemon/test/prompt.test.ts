import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeLayout, resolveAgent } from '@anchi/core';
import { describe, expect, it } from 'vitest';
import { environmentNote, instructions } from '../src/prompt.ts';

function agent(yaml: string) {
  const root = mkdtempSync(join(tmpdir(), 'prompt-'));
  mkdirSync(join(root, 'agents'));
  writeFileSync(join(root, 'agents/dev.yaml'), yaml);
  return resolveAgent('dev', homeLayout(root));
}

describe('environment note', () => {
  it("tells an agent where the user's shared directories are and that ~/work stays in the VM", () => {
    const note = environmentNote(
      agent(
        'runtime: claude-code\nworkspaces:\n  - { path: projects, mode: rw }\n' +
          '  - { path: docs/specs, mode: ro, name: specs }\n',
      ),
    );
    expect(note).toContain(
      'files elsewhere (except in the shared directories below) are discarded',
    );
    expect(note).toContain('/home/agent/work stays inside');
    expect(note).toContain(
      "- /home/agent/workspaces/projects: the user's ~/AnchiWorkspaces/projects, read-write;",
    );
    expect(note).toContain(
      "- /home/agent/workspaces/specs: the user's ~/AnchiWorkspaces/docs/specs, read-only.",
    );
    expect(note).toMatch(/clone .* in a read-write one, not in \/home\/agent\/work/);
  });

  it('keeps work in ~/work when every shared directory is read-only', () => {
    const note = environmentNote(agent('runtime: codex\nworkspaces: [{ path: specs }]\n'));
    expect(note).toContain('read-only.');
    expect(note).toContain('keep your own work in /home/agent/work');
    expect(note).not.toContain('read-write');
  });

  it('says nothing about shared directories when the agent has none', () => {
    const note = environmentNote(agent('runtime: codex\n'));
    expect(note).toContain('Your persistent working directory is /home/agent/work');
    expect(note).not.toContain('/home/agent/workspaces');
  });

  it("comes after the agent's own prompt", () => {
    const { text } = instructions(
      agent(
        'runtime: codex\nprompt: { text: Review code. }\nworkspaces: [{ path: p, mode: rw }]\n',
      ),
    );
    expect(text.indexOf('Review code.')).toBe(0);
    expect(text).toContain('/home/agent/workspaces/p');
  });
});
