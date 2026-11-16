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
  it('names the working directory and says that files elsewhere are discarded', () => {
    const note = environmentNote(agent('runtime: codex\n'));
    expect(note).toContain('Your persistent working directory is /home/agent/work');
    expect(note).toContain('files elsewhere are discarded when the task ends');
    expect(note).toContain('No services are connected');
  });

  it('lists the connected services with how to use them', () => {
    const note = environmentNote(agent('runtime: codex\nconnectors: [github, linear]\n'));
    expect(note).toContain('Connected services:');
    expect(note).toMatch(/- GitHub: `git` over HTTPS/);
    expect(note).toMatch(/- Linear: call the GraphQL API/);
  });

  it("comes after the agent's own prompt", () => {
    const { text, mode } = instructions(agent('runtime: codex\nprompt: { text: Review code. }\n'));
    expect(text.indexOf('Review code.')).toBe(0);
    expect(text).toContain('## Environment');
    expect(mode).toBe('append');
  });
});
