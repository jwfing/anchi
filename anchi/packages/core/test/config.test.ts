import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  ConfigError,
  homeLayout,
  imageHash,
  loadImage,
  mergeLayers,
  patchAgentYaml,
  resolveAgent,
} from '../src/index.ts';

let root: string;
const layout = () => homeLayout(root);

function write(rel: string, content: string) {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anchi-test-'));
});

describe('mergeLayers', () => {
  it('merges objects by key and replaces arrays', () => {
    expect(mergeLayers({ a: { x: 1, y: 2 }, l: [1, 2] }, { a: { y: 3 }, l: [9] })).toEqual({
      a: { x: 1, y: 3 },
      l: [9],
    });
  });
});

describe('resolveAgent', () => {
  it('applies defaults', () => {
    write('agents/dev.yaml', 'runtime: codex\n');
    const agent = resolveAgent('dev', layout());
    expect(agent).toMatchObject({
      id: 'dev',
      name: 'dev',
      connectors: [],
      image: 'codex',
      network: 'proxy',
      sandbox: 'cell',
      prompt: { mode: 'append', text: '' },
    });
  });

  it('merges a template and reads a prompt file relative to the declaring file', () => {
    write('templates/prompts/p.md', 'from file');
    write(
      'templates/base.yaml',
      'runtime: codex\nprompt: { file: prompts/p.md, mode: replace }\nconnectors: [github]\n',
    );
    write('images/node.yaml', 'packages: [nodejs]\n');
    write('agents/dev.yaml', 'extends: base\nconnectors: [github, linear]\nimage: node\n');
    const agent = resolveAgent('dev', layout());
    expect(agent.prompt).toEqual({ mode: 'replace', text: 'from file' });
    expect(agent.connectors).toEqual(['github', 'linear']);
    expect(agent.image).toBe('node');
    expect(agent.sourceFiles).toHaveLength(2);
  });

  it('rejects unknown fields, connectors, images and circular extends', () => {
    write('agents/typo.yaml', 'runtime: codex\nmodle: x\n');
    expect(() => resolveAgent('typo', layout())).toThrow(ConfigError);
    write('agents/c.yaml', 'runtime: codex\nconnectors: [jira]\n');
    expect(() => resolveAgent('c', layout())).toThrow(ConfigError);
    write('agents/r.yaml', 'runtime: codex\nconnectors: [aws, aws]\n');
    expect(() => resolveAgent('r', layout())).toThrow(/must not repeat/);
    write('agents/i.yaml', 'runtime: codex\nimage: nope\n');
    expect(() => resolveAgent('i', layout())).toThrow(/image "nope" not found/);
    write('templates/loop.yaml', 'extends: loop\n');
    write('agents/l.yaml', 'extends: loop\n');
    expect(() => resolveAgent('l', layout())).toThrow(/circular/);
  });

  it('rejects removed my-bot fields and host-execution settings', () => {
    for (const field of ['account: x', 'workspace: { cwd: /tmp }', 'tools: { mcp: [x] }']) {
      write('agents/old.yaml', `runtime: codex\n${field}\n`);
      expect(() => resolveAgent('old', layout())).toThrow(ConfigError);
    }
    write('agents/claude.yaml', 'runtime: claude\n');
    expect(() => resolveAgent('claude', layout())).toThrow(ConfigError);
    write('agents/net.yaml', 'runtime: codex\nnetwork: direct\n');
    expect(() => resolveAgent('net', layout())).toThrow(ConfigError);
  });

  it('rejects an id that does not match the file name', () => {
    write('agents/a.yaml', 'id: b\nruntime: codex\n');
    expect(() => resolveAgent('a', layout())).toThrow(/does not match/);
  });
});

describe('loadImage', () => {
  it('returns the built-in base image and hashes recipes by content', () => {
    expect(loadImage('codex', layout()).hash).toBe('base');
    write('images/node.yaml', 'description: Node\npackages: [nodejs, npm]\nrun: ["npm -v"]\n');
    const image = loadImage('node', layout());
    expect(image.recipe.packages).toEqual(['nodejs', 'npm']);
    expect(image.hash).toBe(imageHash({ ...image.recipe, description: 'other' }));
  });

  it('rejects invalid package names and unknown bases', () => {
    write('images/bad.yaml', 'packages: ["curl; rm -rf /"]\n');
    expect(() => loadImage('bad', layout())).toThrow(ConfigError);
    write('images/from.yaml', 'from: ubuntu\n');
    expect(() => loadImage('from', layout())).toThrow(ConfigError);
  });

  it('reads phase 2 fields: runtime, delegates, triggers, skills and approvals', () => {
    write(
      'agents/lead.yaml',
      [
        'runtime: claude-code',
        'connectors: [linear, slack]',
        'delegates: [dev]',
        'skills: [triage]',
        'approvals: { linear: ask }',
        'triggers:',
        "  - schedule: '0 9 * * 1-5'",
        '    text: Post the daily summary',
        '  - poll: { type: linear-issues, label: agent }',
        '    text: Handle {title} ({url})',
      ].join('\n'),
    );
    const lead = resolveAgent('lead', layout());
    expect(lead).toMatchObject({
      runtime: 'claude-code',
      delegates: ['dev'],
      skills: ['triage'],
      approvals: { linear: 'ask' },
    });
    expect(lead.triggers).toHaveLength(2);
    write('agents/ap.yaml', 'runtime: codex\nconnectors: [notion]\napprovals: { notion: ask }\n');
    expect(resolveAgent('ap', layout()).approvals).toEqual({ notion: 'ask' });
    expect(lead.highRisk).toEqual({ disable: [] });
    write(
      'agents/hr.yaml',
      'runtime: codex\nconnectors: [github]\nhighRisk: { disable: [github-merge] }\n',
    );
    expect(resolveAgent('hr', layout()).highRisk).toEqual({ disable: ['github-merge'] });
    write('agents/hr2.yaml', 'runtime: codex\nhighRisk: { disable: [everything] }\n');
    expect(() => resolveAgent('hr2', layout())).toThrow(ConfigError);
    write('agents/self.yaml', 'runtime: codex\ndelegates: [self]\n');
    expect(() => resolveAgent('self', layout())).toThrow(/delegate to itself/);
    write('agents/sb.yaml', 'runtime: claude-code\nsandbox: codex-workspace-write\n');
    expect(() => resolveAgent('sb', layout())).toThrow(/needs runtime codex/);
    write('agents/cron.yaml', "runtime: codex\ntriggers: [{ schedule: 'daily', text: x }]\n");
    expect(() => resolveAgent('cron', layout())).toThrow();
  });

  it('pins Google accounts for connectors the agent has', () => {
    write(
      'agents/mail.yaml',
      'runtime: codex\nconnectors: [gmail, drive]\naccounts: { gmail: work }\n',
    );
    expect(resolveAgent('mail', layout()).accounts).toEqual({ gmail: 'work' });
    write('agents/plain.yaml', 'runtime: codex\nconnectors: [gmail]\n');
    expect(resolveAgent('plain', layout()).accounts).toEqual({});
    write(
      'agents/missing.yaml',
      'runtime: codex\nconnectors: [gmail]\naccounts: { drive: work }\n',
    );
    expect(() => resolveAgent('missing', layout())).toThrow(/needs its connector/);
    write(
      'agents/notion.yaml',
      'runtime: codex\nconnectors: [notion]\naccounts: { notion: work }\n',
    );
    expect(() => resolveAgent('notion', layout())).toThrow();
    write('agents/bad.yaml', 'runtime: codex\nconnectors: [gmail]\naccounts: { gmail: Work }\n');
    expect(() => resolveAgent('bad', layout())).toThrow();
  });
});

describe('patchAgentYaml', () => {
  it('changes only the patched fields and keeps comments and order', () => {
    const text = [
      '# the developer agent',
      'runtime: codex',
      'connectors: [github] # what it may use',
      'prompt:',
      '  text: |',
      '    Work carefully.',
      'skills: [old]',
      '',
    ].join('\n');
    const out = patchAgentYaml(text, {
      skills: ['review', 'test'],
      connectors: ['github', 'linear'],
      workspaces: [
        { path: 'projects/webapp', mode: 'rw' },
        { path: 'docs', mode: 'ro', name: 'notes' },
      ],
    });
    expect(out).toContain('# the developer agent');
    expect(out).toContain('connectors: [github, linear] # what it may use');
    expect(out).toContain('skills: [review, test]');
    expect(out).toContain('    Work carefully.');
    expect(out.indexOf('connectors')).toBeLessThan(out.indexOf('prompt'));
    expect(out).toMatch(
      /workspaces:\n  - path: projects\/webapp\n    mode: rw\n  - path: docs\n    name: notes/,
    );
  });

  it('removes emptied lists, unless a template must be overridden', () => {
    expect(patchAgentYaml('runtime: codex\nskills: [a]\n', { skills: [] })).toBe(
      'runtime: codex\n',
    );
    expect(patchAgentYaml('extends: base\nskills: [a]\n', { skills: [] })).toContain('skills: []');
    expect(patchAgentYaml('', { skills: ['a'] })).toBe('skills: [a]\n');
    expect(() => patchAgentYaml('- a list\n', { skills: [] })).toThrow(/mapping/);
    expect(patchAgentYaml('delegates: [dev, qa] # team\n', { delegates: ['qa'] })).toBe(
      'delegates: [qa] # team\n',
    );
  });

  it('writes an egress list even when empty, never falling back to open egress', () => {
    expect(patchAgentYaml('runtime: codex\negress: [a.com] # mine\n', { egress: [] })).toBe(
      'runtime: codex\negress: [] # mine\n',
    );
    expect(
      patchAgentYaml('runtime: codex\negress: [a.com]\n', { egress: ['a.com', 'b.org'] }),
    ).toBe('runtime: codex\negress: [a.com, b.org]\n');
  });

  it('sets and removes single values in place, and new ones near the top', () => {
    const text = '# dev\nruntime: codex # which\nmodel: gpt-5.5\nskills: [a]\n';
    expect(patchAgentYaml(text, { runtime: 'claude-code', model: '', name: 'Dev' })).toBe(
      '# dev\nname: Dev\nruntime: claude-code # which\nskills: [a]\n',
    );
    expect(patchAgentYaml(text, { effort: 'high', description: 'Ships' })).toBe(
      '# dev\ndescription: Ships\nruntime: codex # which\nmodel: gpt-5.5\neffort: high\nskills: [a]\n',
    );
    expect(patchAgentYaml('runtime: codex\neffort: low\n', { effort: '' })).toBe(
      'runtime: codex\n',
    );
  });

  it('writes a multi-line prompt as a block, keeping the comments around it', () => {
    const text =
      'runtime: codex\nprompt: { mode: append, text: Old. } # instructions\nskills: [a]\n';
    const out = patchAgentYaml(text, { prompt: { text: 'Line one.\nLine two.\n' } });
    expect(out).toBe(
      'runtime: codex\nprompt:\n  # instructions\n  mode: append\n  text: |\n    Line one.\n    Line two.\nskills: [a]\n',
    );
    expect(parseYaml(out).prompt.text).toBe('Line one.\nLine two.\n');
    expect(
      patchAgentYaml('runtime: codex\n', { prompt: { mode: 'replace', text: 'Short.' } }),
    ).toBe('runtime: codex\nprompt:\n  mode: replace\n  text: Short.\n');
    // Emptied: removed, unless a template's prompt must be overridden.
    expect(patchAgentYaml('runtime: codex\nprompt:\n  text: x\n', { prompt: { text: '' } })).toBe(
      'runtime: codex\n',
    );
    expect(patchAgentYaml('extends: base\n', { prompt: { text: '' } })).toBe(
      'extends: base\nprompt:\n  text: ""\n',
    );
    expect(() =>
      patchAgentYaml('runtime: codex\nprompt: { file: p.md }\n', { prompt: { text: 'x' } }),
    ).toThrow(/prompt comes from a file/);
  });

  it('lets resolveAgent validate a change before it is written', () => {
    write('agents/dev.yaml', 'runtime: codex\n');
    const next = patchAgentYaml('runtime: codex\n', { connectors: ['notion'] });
    expect(resolveAgent('dev', layout(), next).connectors).toEqual(['notion']);
    expect(resolveAgent('dev', layout()).connectors).toEqual([]);
    expect(() => resolveAgent('dev', layout(), 'runtime: codex\nconnectors: [jira]\n')).toThrow(
      ConfigError,
    );
  });
});
