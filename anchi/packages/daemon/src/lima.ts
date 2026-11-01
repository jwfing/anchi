import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { REPO_ROOT } from './host.ts';

/**
 * Lima for the VM. A Lima on PATH that is new enough is used as it is. Otherwise the daemon
 * downloads the release pinned in host-tools.env into <Anchi home>/lima/<version>, checks its
 * SHA-256 before extracting anything, and puts its bin first on PATH, which every setup step,
 * the guest transport and the vault inherit. Lima's own home stays ~/.lima: its socket paths
 * must stay under the 104-byte limit, and Lima resolves symlinks.
 */

/** The official archives are about 40 MB; anything far larger is not one. */
export const MAX_LIMA_ARCHIVE = 200 * 1024 * 1024;

export interface LimaPin {
  version: string;
  sha256: string;
  url: string;
}

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

const TARGETS: Record<string, { key: string; asset: string }> = {
  'darwin-arm64': { key: 'DARWIN_ARM64', asset: 'Darwin-arm64' },
  'linux-x64': { key: 'LINUX_X64', asset: 'Linux-x86_64' },
};

/** The pinned Lima for this computer, or undefined where Anchi does not provide one. */
export function limaPin(
  env: Record<string, string> = readHostTools(),
  platform: string = process.platform,
  arch: string = process.arch,
): LimaPin | undefined {
  const target = TARGETS[`${platform}-${arch}`];
  const version = env.ANCHI_LIMA_VERSION;
  const sha256 = env[`ANCHI_LIMA_SHA256_${target?.key}`];
  if (!target || !version || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return {
    version,
    sha256,
    url: `https://github.com/lima-vm/lima/releases/download/v${version}/lima-${version}-${target.asset}.tar.gz`,
  };
}

export function managedLimaBin(home: string, version: string): string {
  return join(home, 'lima', version, 'bin');
}

/** The first executable `name` in `path`, skipping `skip`. */
export function onPath(name: string, path: string, skip?: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir || dir === skip) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** `a` is at least `b`, both dotted numbers. */
function atLeast(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split('.').map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) {
    const d = (x![i] ?? 0) - (y![i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** The version `limactl --version` prints, or null when it cannot say. */
export function limactlVersion(limactl: string): string | null {
  try {
    const out = execFileSync(limactl, ['--version'], { timeout: 5000 }).toString();
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Puts the downloaded Lima first on PATH unless a Lima of at least `minimum` is already there.
 * Says which one setup steps will use; `none` means ensureLima has to download it.
 */
export function activateLima(
  home: string,
  minimum: string,
  pin: LimaPin | undefined = limaPin(),
  version: (limactl: string) => string | null = limactlVersion,
): 'system' | 'managed' | 'none' {
  const bin = pin ? managedLimaBin(home, pin.version) : undefined;
  const path = process.env.PATH ?? '';
  const system = onPath('limactl', path, bin);
  const found = system ? version(system) : null;
  if (found && atLeast(found, minimum)) return 'system';
  if (!bin || !existsSync(join(bin, 'limactl'))) return 'none';
  if (path.split(delimiter)[0] !== bin) process.env.PATH = [bin, path].join(delimiter);
  return 'managed';
}

/** The archive at `url`; tests replace it. */
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`LIMA_DOWNLOAD_FAILED: ${url} answered ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_LIMA_ARCHIVE) throw new Error('LIMA_DOWNLOAD_FAILED: archive too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_LIMA_ARCHIVE) throw new Error('LIMA_DOWNLOAD_FAILED: archive too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Makes sure setup steps find a Lima of at least `minimum`, downloading the pinned one when
 * needed. A checksum mismatch extracts nothing; an interrupted run leaves only a temporary
 * directory, which the next run replaces.
 */
export async function ensureLima(
  home: string,
  minimum: string,
  onLine: (line: string) => void,
  opts: {
    pin?: LimaPin;
    fetch?: (url: string) => Promise<Buffer>;
    version?: (limactl: string) => string | null;
  } = {},
): Promise<void> {
  const pin = opts.pin ?? limaPin();
  const version = opts.version ?? limactlVersion;
  if (activateLima(home, minimum, pin, version) !== 'none') return;
  if (!pin) {
    throw new Error(`Install Lima ${minimum}+ (https://lima-vm.io), then retry.`);
  }
  onLine(`Downloading Lima ${pin.version} (${pin.url})`);
  const body = await (opts.fetch ?? download)(pin.url);
  if (body.length > MAX_LIMA_ARCHIVE) throw new Error('LIMA_DOWNLOAD_FAILED: archive too large');
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== pin.sha256) {
    throw new Error(`LIMA_CHECKSUM_MISMATCH: expected ${pin.sha256}, got ${digest}`);
  }
  const parent = join(home, 'lima');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(parent, '.download-'));
  try {
    const archive = join(work, 'lima.tar.gz');
    writeFileSync(archive, body, { mode: 0o600 });
    const tree = join(work, 'tree');
    mkdirSync(tree);
    const tar = spawnSync('tar', ['-xzf', archive, '-C', tree], { stdio: 'ignore' });
    if (tar.status !== 0) throw new Error('LIMA_EXTRACT_FAILED: tar could not read the archive');
    const limactl = join(tree, 'bin', 'limactl');
    const found = existsSync(limactl) ? version(limactl) : null;
    if (found !== pin.version) {
      throw new Error(`LIMA_EXTRACT_FAILED: bin/limactl reports ${found ?? 'nothing'}`);
    }
    const target = join(parent, pin.version);
    // Another daemon (or an earlier run that ended after the rename) may have finished first.
    if (!existsSync(join(target, 'bin', 'limactl'))) {
      rmSync(target, { recursive: true, force: true });
      renameSync(tree, target);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (activateLima(home, minimum, pin, version) !== 'managed') {
    throw new Error('LIMA_EXTRACT_FAILED: the downloaded Lima cannot be used');
  }
  onLine(`Lima ${pin.version} is ready in ${join(parent, pin.version)}`);
}
