import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { SkillInfo } from '@anchi/protocol';

/**
 * Skills are `SKILL.md` directories kept in ~/.anchi/skills/<id>. They come from a local
 * directory (copied) or a GitHub URL (fetched once at a resolved commit). Their content is
 * untrusted, like anything else a cell sees; the limits below only keep them small.
 */

export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE = '.anchi-source.json';

export interface SkillFile {
  path: string;
  data: Buffer;
}

/** Files of a skill directory, refusing links, special files and oversize trees. */
export function readSkillTree(dir: string): SkillFile[] {
  const files: SkillFile[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === SOURCE || name === '.git') continue;
      const path = join(d, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink())
        throw new Error(`skills cannot contain links: ${relative(dir, path)}`);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        total += st.size;
        if (files.length >= MAX_SKILL_FILES || total > MAX_SKILL_BYTES) {
          throw new Error(`a skill may have ${MAX_SKILL_FILES} files and 4 MB at most`);
        }
        files.push({ path: relative(dir, path).split(sep).join('/'), data: readFileSync(path) });
      } else throw new Error(`not a regular file: ${relative(dir, path)}`);
    }
  };
  walk(dir);
  if (!files.some((f) => f.path === 'SKILL.md')) throw new Error('a skill needs a SKILL.md');
  return files;
}

/** `name` and `description` from SKILL.md front matter. */
export function skillMeta(skillMd: string): { name: string; description: string } {
  const front = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? '';
  const field = (k: string) =>
    new RegExp(`^${k}:\\s*(.*)$`, 'm')
      .exec(front)?.[1]
      ?.replace(/^["']|["']$/g, '')
      .trim() ?? '';
  return { name: field('name').slice(0, 100), description: field('description').slice(0, 500) };
}

const run = (cmd: string, args: string[], cwd?: string) =>
  new Promise<string>((done, fail) =>
    execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err
        ? fail(new Error(`${cmd} failed: ${stderr.trim().slice(-200) || err.message}`))
        : done(stdout),
    ),
  );

/** owner, repo, ref and path of a GitHub tree URL (or a repository URL). */
export function parseGitHubUrl(url: string) {
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(
      url,
    );
  if (!m)
    throw new Error('use a GitHub URL such as https://github.com/owner/repo/tree/main/skills/x');
  const path = m[4] ?? '';
  if (path.split('/').some((p) => p === '..' || p === '.')) throw new Error('invalid path in URL');
  return { owner: m[1]!, repo: m[2]!, ref: m[3] ?? 'HEAD', path };
}

export class SkillStore {
  constructor(private root: string) {}

  dir(id: string): string {
    if (!ID.test(id)) throw new Error(`invalid skill id "${id}"`);
    return join(this.root, id);
  }

  list(): SkillInfo[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((id) => ID.test(id) && existsSync(join(this.root, id, 'SKILL.md')))
      .sort()
      .map((id) => {
        const meta = skillMeta(readFileSync(join(this.root, id, 'SKILL.md'), 'utf8'));
        let source: { url?: string; commit?: string } = {};
        try {
          source = JSON.parse(readFileSync(join(this.root, id, SOURCE), 'utf8')) as typeof source;
        } catch {
          // Added from a local directory.
        }
        return {
          id,
          name: meta.name || id,
          description: meta.description,
          source: source.url ?? 'local',
          commit: source.commit ?? null,
        };
      });
  }

  /** Adds or replaces a skill from a local directory or a GitHub URL. */
  async add(source: string, id?: string): Promise<SkillInfo> {
    const work = mkdtempSync(join(tmpdir(), 'anchi-skill-'));
    try {
      let dir: string;
      let origin: { url: string; commit: string } | undefined;
      if (source.startsWith('https://')) {
        const g = parseGitHubUrl(source);
        const sha = (
          await run('git', ['ls-remote', `https://github.com/${g.owner}/${g.repo}.git`, g.ref])
        ).split(/\s/)[0];
        const commit = /^[0-9a-f]{40}$/.test(sha ?? '')
          ? sha!
          : /^[0-9a-f]{40}$/.test(g.ref)
            ? g.ref
            : '';
        if (!commit) throw new Error(`cannot resolve ${g.ref} in ${g.owner}/${g.repo}`);
        const res = await fetch(
          `https://codeload.github.com/${g.owner}/${g.repo}/tar.gz/${commit}`,
        );
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > 64 * 1024 * 1024) throw new Error('repository archive too large');
        writeFileSync(join(work, 'src.tgz'), body);
        mkdirSync(join(work, 'x'));
        await run('tar', ['-xzf', join(work, 'src.tgz'), '-C', join(work, 'x'), '--no-same-owner']);
        const top = readdirSync(join(work, 'x'))[0];
        if (!top) throw new Error('empty archive');
        dir = resolve(join(work, 'x', top), g.path);
        if (!dir.startsWith(join(work, 'x', top))) throw new Error('invalid path in URL');
        origin = { url: source, commit };
        id ??= (g.path.split('/').filter(Boolean).at(-1) ?? g.repo).toLowerCase();
      } else {
        dir = resolve(source);
        id ??= dir.split(sep).filter(Boolean).at(-1)?.toLowerCase();
      }
      if (!id || !ID.test(id))
        throw new Error('give the skill an id: 1–40 lowercase letters, digits or "-"');
      if (!existsSync(dir) || !lstatSync(dir).isDirectory())
        throw new Error(`no skill directory at ${source}`);
      const files = readSkillTree(dir);
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const staged = join(this.root, `.${id}.new`);
      rmSync(staged, { recursive: true, force: true });
      for (const f of files) {
        mkdirSync(join(staged, f.path, '..'), { recursive: true });
        writeFileSync(join(staged, f.path), f.data);
      }
      if (origin) writeFileSync(join(staged, SOURCE), JSON.stringify(origin, null, 2));
      rmSync(this.dir(id), { recursive: true, force: true });
      renameSync(staged, this.dir(id));
      return this.list().find((s) => s.id === id)!;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /**
   * The agent's skills as one bundle for the guest: a Claude Code plugin root
   * (`.claude-plugin/plugin.json`, `skills/<id>/…`) whose `skills/` also serves Codex.
   */
  bundle(ids: string[]): { files: Record<string, string>; digest: string } {
    const files: Record<string, string> = {
      '.claude-plugin/plugin.json': Buffer.from(
        JSON.stringify({ name: 'anchi-skills', description: 'Skills assigned by Anchi' }),
      ).toString('base64'),
    };
    for (const id of [...ids].sort()) {
      if (!existsSync(join(this.dir(id), 'SKILL.md')))
        throw new Error(`skill "${id}" is not installed`);
      for (const f of readSkillTree(this.dir(id)))
        files[`skills/${id}/${f.path}`] = f.data.toString('base64');
    }
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
    return { files, digest };
  }
}
