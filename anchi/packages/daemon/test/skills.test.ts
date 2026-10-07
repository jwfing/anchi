import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGitHubUrl, SkillStore } from '../src/skills.ts';

function skillDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-src-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('skills', () => {
  it('adds local skills and bundles them as a plugin root', async () => {
    const store = new SkillStore(mkdtempSync(join(tmpdir(), 'skills-')));
    const src = skillDir({
      'SKILL.md': '---\nname: Triage\ndescription: Sort incoming issues\n---\nSteps…',
      'scripts/label.sh': 'echo hi',
    });
    const s = await store.add(src, 'triage');
    expect(s).toMatchObject({
      id: 'triage',
      name: 'Triage',
      description: 'Sort incoming issues',
      source: 'local',
    });
    const { files, digest } = store.bundle(['triage']);
    expect(Object.keys(files).sort()).toEqual([
      '.claude-plugin/plugin.json',
      'skills/triage/SKILL.md',
      'skills/triage/scripts/label.sh',
    ]);
    expect(Buffer.from(files['skills/triage/scripts/label.sh']!, 'base64').toString()).toBe(
      'echo hi',
    );
    expect(store.bundle(['triage']).digest).toBe(digest);
    expect(() => store.bundle(['missing'])).toThrow(/not installed/);
    store.remove('triage');
    expect(store.list()).toEqual([]);
  });

  it('refuses links, missing SKILL.md and bad ids or URLs', async () => {
    const store = new SkillStore(mkdtempSync(join(tmpdir(), 'skills-')));
    const linked = skillDir({ 'SKILL.md': 'x' });
    symlinkSync('/etc/passwd', join(linked, 'passwd'));
    await expect(store.add(linked, 'linked')).rejects.toThrow(/links/);
    await expect(store.add(skillDir({ 'README.md': 'x' }), 'nope')).rejects.toThrow(/SKILL.md/);
    await expect(store.add(skillDir({ 'SKILL.md': 'x' }), 'Bad Id')).rejects.toThrow(/id/);
    expect(parseGitHubUrl('https://github.com/o/r/tree/main/skills/x')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'skills/x',
    });
    expect(parseGitHubUrl('https://github.com/o/r')).toMatchObject({ ref: 'HEAD', path: '' });
    expect(() => parseGitHubUrl('https://gitlab.com/o/r')).toThrow();
    expect(() => parseGitHubUrl('https://github.com/o/r/tree/main/../../x')).toThrow();
  });
});
