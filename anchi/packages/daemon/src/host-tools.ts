import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './host.ts';

/**
 * Host tools Anchi downloads for itself when the computer lacks them (Lima, the Codex CLI that
 * signs in to ChatGPT). Each is pinned in host-tools.env with a SHA-256 per target, checked
 * before anything is extracted, and installed into a directory of its own under the Anchi home.
 */

/** `KEY=value` lines; comments and anything that does not look like a pin are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=([A-Za-z0-9._-]*)$/.exec(line.trim());
    if (m) values[m[1]!] = m[2]!;
  }
  return values;
}

export function readHostTools(root = REPO_ROOT): Record<string, string> {
  try {
    return parseEnv(readFileSync(join(root, 'host-tools.env'), 'utf8'));
  } catch {
    return {};
  }
}

/** The two hosts Anchi provides tools for, with each tool's name for them. */
export const HOST_TARGETS: Record<string, { key: string; lima: string; codex: string }> = {
  'darwin-arm64': { key: 'DARWIN_ARM64', lima: 'Darwin-arm64', codex: 'aarch64-apple-darwin' },
  'linux-x64': { key: 'LINUX_X64', lima: 'Linux-x86_64', codex: 'x86_64-unknown-linux-musl' },
};

export interface Pin {
  version: string;
  sha256: string;
  url: string;
}

/** `prefix_VERSION` and `prefix_SHA256_<target>`, or undefined when either is missing or malformed. */
export function readPin(
  env: Record<string, string>,
  prefix: string,
  platform: string,
  arch: string,
  url: (version: string, target: (typeof HOST_TARGETS)[string]) => string,
): Pin | undefined {
  const target = HOST_TARGETS[`${platform}-${arch}`];
  const version = env[`${prefix}_VERSION`];
  const sha256 = env[`${prefix}_SHA256_${target?.key}`];
  if (!target || !version || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { version, sha256, url: url(version, target) };
}

/** The body at `url`, refused past `max` bytes; tests replace it. */
export async function download(url: string, max: number, code: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body)
    throw new Error(`${code}_DOWNLOAD_FAILED: ${url} answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    throw new Error(`${code}_DOWNLOAD_FAILED: archive too large`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error(`${code}_DOWNLOAD_FAILED: archive too large`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Checks `body` against the pin, extracts it into a temporary directory under `parent`, lets
 * `check` accept the tree (it throws otherwise), then renames the tree to `parent/<version>`.
 * A mismatch extracts nothing; an interrupted run leaves only a temporary directory, removed
 * here or replaced by the next run. Error codes start with `code` (LIMA, CODEX).
 */
export function installArchive(
  body: Buffer,
  pin: Pin,
  parent: string,
  code: string,
  check: (tree: string) => void,
): string {
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== pin.sha256) {
    throw new Error(`${code}_CHECKSUM_MISMATCH: expected ${pin.sha256}, got ${digest}`);
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = join(parent, pin.version);
  const work = mkdtempSync(join(parent, '.download-'));
  try {
    const archive = join(work, 'archive.tar.gz');
    writeFileSync(archive, body, { mode: 0o600 });
    const tree = join(work, 'tree');
    mkdirSync(tree);
    const tar = spawnSync('tar', ['-xzf', archive, '-C', tree], { stdio: 'ignore' });
    if (tar.status !== 0) throw new Error(`${code}_EXTRACT_FAILED: tar could not read the archive`);
    check(tree);
    // Another daemon (or an earlier run that ended after the rename) may have finished first.
    if (!existsSync(target) || !existsSync(join(target, '.complete'))) {
      writeFileSync(join(tree, '.complete'), `${pin.sha256}\n`);
      rmSync(target, { recursive: true, force: true });
      renameSync(tree, target);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return target;
}
