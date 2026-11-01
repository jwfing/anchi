import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { download, installArchive, readHostTools, readPin, type Pin } from './host-tools.ts';

export { parseEnv, readHostTools } from './host-tools.ts';

/**
 * Lima for the VM. A Lima on PATH that is new enough is used as it is. Otherwise the daemon
 * downloads the release pinned in host-tools.env into <Anchi home>/lima/<version>, checks its
 * SHA-256 before extracting anything, and puts its bin first on PATH, which every setup step,
 * the guest transport and the vault inherit. Lima's own home stays ~/.lima: its socket paths
 * must stay under the 104-byte limit, and Lima resolves symlinks.
 */

/** The official archives are about 40 MB; anything far larger is not one. */
export const MAX_LIMA_ARCHIVE = 200 * 1024 * 1024;

export type LimaPin = Pin;

/** The pinned Lima for this computer, or undefined where Anchi does not provide one. */
export function limaPin(
  env: Record<string, string> = readHostTools(),
  platform: string = process.platform,
  arch: string = process.arch,
): LimaPin | undefined {
  return readPin(
    env,
    'ANCHI_LIMA',
    platform,
    arch,
    (version, target) =>
      `https://github.com/lima-vm/lima/releases/download/v${version}/lima-${version}-${target.lima}.tar.gz`,
  );
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
  const body = await (opts.fetch ?? ((url) => download(url, MAX_LIMA_ARCHIVE, 'LIMA')))(pin.url);
  if (body.length > MAX_LIMA_ARCHIVE) throw new Error('LIMA_DOWNLOAD_FAILED: archive too large');
  installArchive(body, pin, join(home, 'lima'), 'LIMA', (tree) => {
    const limactl = join(tree, 'bin', 'limactl');
    const found = existsSync(limactl) ? version(limactl) : null;
    if (found !== pin.version) {
      throw new Error(`LIMA_EXTRACT_FAILED: bin/limactl reports ${found ?? 'nothing'}`);
    }
  });
  if (activateLima(home, minimum, pin, version) !== 'managed') {
    throw new Error('LIMA_EXTRACT_FAILED: the downloaded Lima cannot be used');
  }
  onLine(`Lima ${pin.version} is ready in ${join(home, 'lima', pin.version)}`);
}
