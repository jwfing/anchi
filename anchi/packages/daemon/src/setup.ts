import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONNECTOR_IDS } from '@anchi/protocol';
import type {
  ClaudeAccountStatus,
  HermesAccountStatus,
  ConnectorStatus,
  RuntimeAccountStatus,
  SetupStatus,
} from '@anchi/protocol';
import type { Guest, LimaTransport } from './guest.ts';
import { APP_VERSION, defaultVmSize, hostResources, REPO_ROOT, VAULT_KEY } from './host.ts';
import type { ServiceSetup } from './services.ts';

export { CONNECTOR_IDS };

/**
 * Reads the access token and account id from the host Codex login. Only the access token
 * leaves the host (to the vault); the refresh token stays with the host Codex CLI, which keeps
 * refreshing it. Re-import when the access token expires.
 */
export const HOST_CODEX_LOGIN = join(
  process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  'auth.json',
);

/** Expiry (ms) in a JWT's claims, without verifying it; the upstream service verifies. */
export function jwtExpiry(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function readHostCodexLogin(file = HOST_CODEX_LOGIN): {
  accessToken: string;
  accountId: string;
} {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no Codex login at ${file}; run \`codex login\` on this computer first`);
  }
  const value = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } };
  const accessToken = value.tokens?.access_token;
  const accountId = value.tokens?.account_id;
  if (typeof accessToken !== 'string' || typeof accountId !== 'string') {
    throw new Error('the host Codex login is not a ChatGPT subscription login');
  }
  return { accessToken, accountId };
}

export async function claudeStatus(guest: Guest): Promise<ClaudeAccountStatus> {
  const s = await guest.claudeStatus();
  return { runtime: 'claude-code', connected: s.configured, kind: s.kind };
}

export async function hermesStatus(guest: Guest): Promise<HermesAccountStatus> {
  const s = await guest.hermesStatus();
  return { runtime: 'hermes', connected: s.configured, baseUrl: s.base_url, model: s.model };
}

export async function codexStatus(guest: Guest): Promise<RuntimeAccountStatus> {
  const s = await guest.codexStatus();
  return {
    runtime: 'codex',
    connected: s.configured,
    accountId: s.account_id,
    expiresAt: s.expires_at ? s.expires_at * 1000 : null,
  };
}

export async function connectorStatuses(guest: Guest): Promise<ConnectorStatus[]> {
  const all = await guest.connectorStatus();
  return CONNECTOR_IDS.map((id) => ({
    id,
    connected: Boolean(all[id]?.connected),
    account: all[id]?.account ?? null,
  }));
}

/** `a` is at least `b`, both dotted numbers (`2.10.0` is newer than `2.2.0`). */
export function versionAtLeast(a: string, b: string): boolean {
  const parts = (v: string) => v.split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** The Lima the VM template needs (`minimumLimaVersion` in lima/anchi-vm.yaml). */
export function limaMinimum(root = REPO_ROOT): string {
  try {
    const text = readFileSync(join(root, 'lima/anchi-vm.yaml'), 'utf8');
    return /^minimumLimaVersion:\s*(\d+\.\d+\.\d+)/m.exec(text)?.[1] ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The dotted version in `limactl --version` output (`limactl version 2.2.0`), or null. */
export function parseLimaVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

let limaVersionCache: { at: number; version: string | null } | undefined;
/** The installed Lima's version, asked at most once a minute; null when it cannot say. */
function limaVersion(): string | null {
  if (limaVersionCache && Date.now() - limaVersionCache.at < 60_000) {
    return limaVersionCache.version;
  }
  let version: string | null = null;
  try {
    version = parseLimaVersion(
      execFileSync('limactl', ['--version'], { timeout: 5000 }).toString(),
    );
  } catch {
    // Not installed or not answering: `missing` already names limactl.
  }
  limaVersionCache = { at: Date.now(), version };
  return version;
}

export function hostReadiness(): NonNullable<SetupStatus['host']> {
  const executable = (name: string) =>
    (process.env.PATH ?? '').split(':').some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const missing = ['limactl', 'python3'].filter((name) => !executable(name));
  // An older Lima fails only at `limactl start`, deep in the installation log; say it here.
  const minimum = limaMinimum();
  const found = missing.includes('limactl') ? null : limaVersion();
  if (found && !versionAtLeast(found, minimum)) missing.push(`Lima ${minimum}+ (found ${found})`);
  if (process.platform === 'linux') {
    if (!executable('qemu-system-x86_64')) missing.push('qemu-system-x86_64');
    try {
      accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    } catch {
      missing.push('/dev/kvm access');
    }
  }
  return {
    platform: process.platform,
    missing,
    installHint:
      process.platform === 'darwin'
        ? 'brew install lima python (brew upgrade lima for a newer Lima)'
        : `Install Lima ${minimum}+ (https://lima-vm.io), Python 3.11+ and QEMU. Ubuntu/Debian: sudo apt-get install python3 qemu-system-x86 qemu-utils. Enable KVM access, then reopen Anchi.`,
  };
}

export async function setupStatus(
  guest: Guest,
  lima: LimaTransport,
  services?: ServiceSetup,
): Promise<SetupStatus> {
  const vm = await lima.vmStatus();
  const host = hostResources();
  const empty: SetupStatus = {
    vm,
    host: hostReadiness(),
    vaultKeyPresent: existsSync(VAULT_KEY),
    vaultUnlocked: false,
    installed: false,
    codex: { runtime: 'codex', connected: false, accountId: null, expiresAt: null },
    claude: { runtime: 'claude-code', connected: false, kind: null },
    hermes: { runtime: 'hermes', connected: false, baseUrl: null, model: null },
    services: [],
    googleClient: false,
    googleClientSource: null,
    workspaces: false,
    connectors: CONNECTOR_IDS.map((id) => ({ id, connected: false, account: null })),
    vmSize: { default: defaultVmSize(host), host },
    appVersion: APP_VERSION,
    guestVersion: null,
    guestOutdated: false,
  };
  if (vm !== 'running') return empty;
  // Shown on the Runtimes screen; a Lima that cannot say leaves it out.
  const current = await lima.vmSize().catch(() => undefined);
  if (current) empty.vmSize = { ...empty.vmSize!, current };
  try {
    const [vault, codex, claude, hermes, connectors, base, workspaces, guestVersion] =
      await Promise.all([
        guest.vaultStatus(),
        codexStatus(guest),
        claudeStatus(guest),
        // A guest installed before Hermes support has no hermes_admin.py.
        hermesStatus(guest).catch(() => empty.hermes!),
        connectorStatuses(guest),
        guest.imageStatus('codex', 'base').catch(() => false),
        guest.workspacesMounted().catch(() => false),
        guest.version().catch(() => null),
      ]);
    const svc = (await services?.status().catch(() => undefined)) ?? {
      services: [],
      googleClient: false,
      googleClientSource: null,
    };
    return {
      ...empty,
      vm,
      vaultUnlocked: vault.unlocked,
      installed: base,
      codex,
      claude,
      hermes,
      connectors,
      services: svc.services,
      googleClient: svc.googleClient,
      googleClientSource: svc.googleClientSource,
      workspaces,
      guestVersion,
      // Until the base image is built, installing is the next step anyway. A guest too old to
      // say its version is older than this Anchi.
      guestOutdated: base && guestVersion !== APP_VERSION,
    };
  } catch (err) {
    // The VM runs but a guest command failed (sudo, a missing script, an SSH hiccup): say so
    // instead of showing everything as not installed.
    return { ...empty, error: (err as Error).message.slice(0, 300) };
  }
}
