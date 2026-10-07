import { readFileSync } from 'node:fs';
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

export const CONNECTOR_IDS: ConnectorId[] = ['github', 'aws', 'linear'];

/**
 * Reads the access token and account id from the host Codex login. Only the access token
 * leaves the host (to the vault); the refresh token stays with the host Codex CLI, which keeps
 * refreshing it. Re-import when the access token expires.
 */
export function readHostCodexLogin(
  file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
): { accessToken: string; accountId: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no Codex login at ${file}; run \`codex login\` on this Mac first`);
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

export async function setupStatus(guest: Guest, lima: LimaTransport): Promise<SetupStatus> {
  const vm = await lima.vmStatus();
  const empty: SetupStatus = {
    vm,
    vaultUnlocked: false,
    installed: false,
    codex: { runtime: 'codex', connected: false, accountId: null, expiresAt: null },
    claude: { runtime: 'claude-code', connected: false, kind: null },
    connectors: CONNECTOR_IDS.map((id) => ({ id, connected: false, account: null })),
  };
  if (vm !== 'running') return empty;
  try {
    const [vault, codex, claude, connectors, base] = await Promise.all([
      guest.vaultStatus(),
      codexStatus(guest),
      claudeStatus(guest),
      connectorStatuses(guest),
      guest.imageStatus('codex', 'base').catch(() => false),
    ]);
    return { vm, vaultUnlocked: vault.unlocked, installed: base, codex, claude, connectors };
  } catch {
    return empty;
  }
}
