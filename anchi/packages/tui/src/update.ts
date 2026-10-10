import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const INSTALL = 'curl -fsSL https://anchi.elseward.xyz/install.sh | sh';
const LATEST = 'https://api.github.com/repos/jwfing/anchi/releases/latest';
const exec = promisify(execFile);

/** Only switch the installation that owns this running binary, never another PATH entry. */
export function managedRoot(app: string): string {
  try {
    const resolved = realpathSync(app);
    const root = dirname(dirname(dirname(resolved)));
    if (
      existsSync(join(resolved, 'manifest.json')) &&
      existsSync(join(resolved, 'scripts/update.sh')) &&
      dirname(dirname(resolved)) === join(root, 'versions') &&
      realpathSync(join(root, 'current')) === resolved
    )
      return root;
  } catch {
    /* A checkout, extracted archive or inactive old version is not managed. */
  }
  throw new Error(
    `Self-update requires the active installer-managed copy of Anchi. Install or update with:\n${INSTALL}`,
  );
}

function parts(version: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unsupported release version: ${version}`);
  const result = version.split('.').map(Number);
  if (!result.every(Number.isSafeInteger)) throw new Error('Invalid release version');
  return result;
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a),
    right = parts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  }
  return 0;
}

export async function latestVersion(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'curl',
      ['-fsSL', '--connect-timeout', '15', '--max-time', '30', LATEST],
      { maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new Error(
      'Could not check GitHub for updates (network or API rate limit). Try again later. Nothing was changed.',
    );
  }
  const release = JSON.parse(stdout) as {
    tag_name?: unknown;
    draft?: boolean;
    prerelease?: boolean;
  };
  if (
    release.draft ||
    release.prerelease ||
    typeof release.tag_name !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
  ) {
    throw new Error('GitHub did not return a supported stable release. Nothing was changed.');
  }
  return release.tag_name.slice(1);
}

async function install(app: string, root: string, version: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', [join(app, 'scripts/update.sh')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ANCHI_INSTALL_ROOT: root,
        ANCHI_UPDATE_ONLY: '1',
        ANCHI_VERSION: `v${version}`,
      },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Update failed (${signal ?? code}). The installer keeps the previous version when downloading or verification fails.`,
            ),
          ),
    );
  });
}

export async function selfUpdate(
  app: string,
  current: string,
  check = false,
  io = { latest: latestVersion, install, log: (message: string) => console.log(message) },
): Promise<void> {
  // --check is useful from a checkout too; installation itself requires a managed package.
  const root = check ? undefined : managedRoot(app);
  const latest = await io.latest();
  const order = compareVersions(latest, current);
  if (order <= 0) {
    io.log(
      order === 0
        ? `Anchi ${current} is up to date.`
        : `Anchi ${current} is newer than the latest release (${latest}); no downgrade performed.`,
    );
    return;
  }
  io.log(`Anchi ${current} → ${latest}`);
  if (check) {
    io.log('Run anchi update to install this release.');
    return;
  }
  await io.install(app, root!, latest);
  io.log(
    `Updated to Anchi ${latest}. Existing tasks and daemons keep running.\nAfter tasks finish, run anchi daemon stop, then reopen anchi.\nIf login startup is enabled, also run anchi daemon install.`,
  );
}
