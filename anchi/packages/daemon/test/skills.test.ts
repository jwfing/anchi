import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGitHubUrl, type SkillRemote, SkillStore } from '../src/skills.ts';

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

/** A GitHub stand-in: a ref that moves between commits, served as tarballs made here. */
function fakeRemote() {
  const commits = new Map<string, Record<string, string>>();
  let head = '';
  const remote: SkillRemote & { push(files: Record<string, string>): string; resolves: string[] } =
    {
      resolves: [],
      push(files) {
        head = String(commits.size + 1).repeat(40);
        commits.set(head, files);
        return head;
      },
      async resolve(owner, repo, ref) {
        remote.resolves.push(`${owner}/${repo}@${ref}`);
        return head;
      },
      async download(_owner, repo, commit) {
        const files = commits.get(commit);
        if (!files) throw new Error('download failed: HTTP 404');
        const dir = skillDir(
          Object.fromEntries(Object.entries(files).map(([p, t]) => [`${repo}-${commit}/${p}`, t])),
        );
        return execFileSync('tar', ['-czf', '-', '-C', dir, `${repo}-${commit}`]);
      },
    };
  return remote;
}

describe('skill updates', () => {
  const url = 'https://github.com/acme/skills/tree/main/skills/review';
  const v1 = {
    'skills/review/SKILL.md': '---\nname: review\ndescription: Reviews code\n---\nv1',
    'skills/review/notes.md': 'old notes',
  };

  it('pins GitHub skills to a commit and shows what an update changes before applying it', async () => {
    const remote = fakeRemote();
    const first = remote.push(v1);
    const store = new SkillStore(mkdtempSync(join(tmpdir(), 'skills-')), remote);
    expect(await store.add(url)).toMatchObject({ id: 'review', commit: first, source: url });
    expect(await store.checkUpdate('review')).toMatchObject({ upToDate: true, latest: first });

    const second = remote.push({
      'skills/review/SKILL.md': '---\nname: review\ndescription: Reviews code\n---\nv2',
      'skills/review/checklist.md': 'new',
    });
    const update = await store.checkUpdate('review');
    expect(update).toEqual({
      id: 'review',
      url,
      current: first,
      latest: second,
      upToDate: false,
      added: ['checklist.md'],
      changed: ['SKILL.md'],
      removed: ['notes.md'],
    });
    // Checking changed nothing; updating installs exactly the reviewed commit.
    expect(readFileSync(join(store.dir('review'), 'SKILL.md'), 'utf8')).toMatch(/v1/);
    remote.push({ 'skills/review/SKILL.md': '---\nname: review\n---\nv3' });
    expect(await store.update('review', second)).toMatchObject({ commit: second });
    expect(readFileSync(join(store.dir('review'), 'SKILL.md'), 'utf8')).toMatch(/v2/);
    await expect(store.update('review', 'main')).rejects.toThrow(/40-character/);
    expect(remote.resolves.every((r) => r === 'acme/skills@main')).toBe(true);
  });

  it('refuses to update local skills', async () => {
    const store = new SkillStore(mkdtempSync(join(tmpdir(), 'skills-')), fakeRemote());
    await store.add(skillDir({ 'SKILL.md': '---\nname: x\n---' }), 'local-one');
    await expect(store.checkUpdate('local-one')).rejects.toThrow(/local directory/);
    await expect(store.update('local-one', 'a'.repeat(40))).rejects.toThrow(/local directory/);
  });
});
