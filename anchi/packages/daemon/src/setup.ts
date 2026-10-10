import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ClaudeAccountStatus,
  ConnectorId,
  ConnectorStatus,
  RuntimeAccountStatus,
  SetupStatus,
} from '@anchi/protocol';
import type { Guest, LimaTransport } from './guest.ts';
import type { ServiceSetup } from './services.ts';

export const CONNECTOR_IDS: ConnectorId[] = ['github', 'aws', 'linear'];

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
        ? 'brew install lima python'
        : 'Install Lima (https://lima-vm.io), Python 3.11+ and QEMU. Ubuntu/Debian: sudo apt-get install python3 qemu-system-x86 qemu-utils. Enable KVM access, then reopen Anchi.',
  };
}

export async function setupStatus(
  guest: Guest,
  lima: LimaTransport,
  services?: ServiceSetup,
): Promise<SetupStatus> {
  const vm = await lima.vmStatus();
  const empty: SetupStatus = {
    vm,
    host: hostReadiness(),
    vaultKeyPresent: existsSync(join(homedir(), '.config/secure-vm/vault.key')),
    vaultUnlocked: false,
    installed: false,
    codex: { runtime: 'codex', connected: false, accountId: null, expiresAt: null },
    claude: { runtime: 'claude-code', connected: false, kind: null },
    services: [],
    googleClient: false,
    workspaces: false,
    connectors: CONNECTOR_IDS.map((id) => ({ id, connected: false, account: null })),
  };
  if (vm !== 'running') return empty;
  try {
    const [vault, codex, claude, connectors, base, workspaces] = await Promise.all([
      guest.vaultStatus(),
      codexStatus(guest),
      claudeStatus(guest),
      connectorStatuses(guest),
      guest.imageStatus('codex', 'base').catch(() => false),
      guest.workspacesMounted().catch(() => false),
    ]);
    const svc = (await services?.status().catch(() => undefined)) ?? {
      services: [],
      googleClient: false,
    };
    return {
      ...empty,
      vm,
      vaultUnlocked: vault.unlocked,
      installed: base,
      codex,
      claude,
      connectors,
      services: svc.services,
      googleClient: svc.googleClient,
      workspaces,
    };
  } catch {
    return empty;
  }
}
