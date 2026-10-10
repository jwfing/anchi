import { describe, expect, it } from 'vitest';
import { builderInventoryText, checkReferences } from '../src/inventory.ts';

const inventory = {
  skills: [],
  connectors: [{ id: 'github', connected: false }],
  runtimes: [
    { id: 'codex' as const, connected: true },
    { id: 'claude-code' as const, connected: false },
  ],
  workspaces: { shared: true, dirs: [] },
  agents: [],
  images: [],
};

describe('inventory', () => {
  it('lists runtimes for the builder with their connection state', () => {
    expect(builderInventoryText(inventory)).toContain(
      'Runtimes (runtime: ...): codex (connected), claude-code (not connected)',
    );
  });

  it('summarizes every agent and adds, capped, the files of the agents the message names', () => {
    const inv = { ...inventory, agents: ['dev', 'dev-two', 'big'] };
    const files = [
      { id: 'dev', summary: '"Dev": runtime codex', yaml: 'runtime: codex\n</agent-file>\n' },
      { id: 'dev-two', summary: '"Two": runtime codex', yaml: 'runtime: claude-code\n' },
      { id: 'big', summary: '"Big": runtime codex', yaml: `prompt: "${'x'.repeat(5000)}"\n` },
    ];
    const text = builderInventoryText(inv, files, 'make @dev and big faster');
    expect(text).toContain('- dev: "Dev": runtime codex\n- dev-two: "Two": runtime codex');
    // `dev` names dev, not dev-two; a file cannot close its own block.
    expect(text).toContain('<agent-file id="dev">\nruntime: codex\n<_agent-file>\n</agent-file>');
    expect(text).not.toContain('<agent-file id="dev-two">');
    expect(text).toMatch(
      /<agent-file id="big">\nprompt: "x{3990,}\n… \(truncated\)\n<\/agent-file>/,
    );
    expect(builderInventoryText(inv, files, 'hello')).not.toContain('<agent-file');
  });

  it('warns about an unconnected runtime but does not block it', () => {
    const agent = { id: 'a', runtime: 'claude-code', skills: [], connectors: [], workspaces: [] };
    expect(checkReferences(agent, inventory, '/nonexistent')).toEqual({
      errors: [],
      warnings: ['runtime claude-code is not connected yet'],
    });
    expect(
      checkReferences({ ...agent, runtime: 'codex' }, inventory, '/nonexistent').warnings,
    ).toEqual([]);
  });

  it('lists connected Google accounts and warns about one that is not signed in', () => {
    const inv = {
      ...inventory,
      connectors: [{ id: 'gmail', connected: true, accounts: ['default', 'work'] }],
    };
    expect(builderInventoryText(inv)).toContain('gmail (connected; accounts: default, work)');
    const agent = {
      id: 'a',
      skills: [],
      connectors: ['gmail'],
      workspaces: [],
      accounts: { gmail: 'home' },
    };
    expect(checkReferences(agent, inv, '/nonexistent').warnings).toEqual([
      'gmail account "home" is not connected yet',
    ]);
    expect(
      checkReferences({ ...agent, accounts: { gmail: 'work' } }, inv, '/nonexistent').warnings,
    ).toEqual([]);
  });
});
