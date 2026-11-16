import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONNECTOR_IDS } from '@anchi/protocol';
import type {
  ClaudeAccountStatus,
  HermesAccountStatus,
  ConnectorStatus,
  RuntimeAccountStatus,
  RuntimeId,
  SetupAction,
  SetupStatus,
} from '@anchi/protocol';
import type { Guest, VmTransport } from './guest.ts';
import { APP_VERSION, VAULT_KEY } from './host.ts';
import { opensslAvailable } from './host-placement.ts';
import type { ServiceSetup } from './services.ts';

export { CONNECTOR_IDS };

export { HOST_CODEX_LOGIN, jwtExpiry, readHostCodexLogin } from './host-logins.ts';

export async function claudeStatus(guest: Guest): Promise<ClaudeAccountStatus> {
  const s = await guest.claudeStatus();
  return {
    runtime: 'claude-code',
    connected: s.configured,
    kind: s.kind,
    expiresAt: s.expires_at ? s.expires_at * 1000 : null,
  };
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

export function hostReadiness(
  placement: VmTransport['placement'] = 'host',
): NonNullable<SetupStatus['host']> {
  const executable = (name: string) =>
    (process.env.PATH ?? '').split(':').some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (placement === 'local') {
    // Inside the guest: the installers need Python and reach guest root with `sudo -n`.
    return {
      platform: process.platform,
      missing: ['python3', 'sudo'].filter((name) => !executable(name)),
      installHint: 'This server needs Python 3.11+ and passwordless sudo for its login user.',
    };
  }
  // No guest: the services run on the daemon's own Node; openssl signs the proxy's certificates.
  return {
    platform: process.platform,
    missing: opensslAvailable() ? [] : ['openssl'],
    installHint:
      process.platform === 'darwin'
        ? 'macOS ships openssl; put /usr/bin on PATH, then prepare again.'
        : 'Install the openssl command line (Debian/Ubuntu: sudo apt-get install openssl), then prepare again.',
  };
}

export async function setupStatus(
  guest: Guest,
  transport: VmTransport,
  services?: ServiceSetup,
): Promise<SetupStatus> {
  const vm = await transport.vmStatus();
  const empty: SetupStatus = {
    quickSetup: true,
    preparedRuntimes: [],
    vm,
    host: hostReadiness(transport.placement),
    vaultKeyPresent: existsSync(VAULT_KEY),
    vaultUnlocked: false,
    installed: false,
    codex: { runtime: 'codex', connected: false, accountId: null, expiresAt: null },
    claude: { runtime: 'claude-code', connected: false, kind: null },
    hermes: { runtime: 'hermes', connected: false, baseUrl: null, model: null },
    services: [],
    googleClient: false,
    xClient: false,
    redditClient: false,
    googleClientSource: null,
    workspaces: false,
    connectors: CONNECTOR_IDS.map((id) => ({ id, connected: false, account: null })),
    appVersion: APP_VERSION,
    guestVersion: null,
    guestOutdated: false,
  };
  if (vm !== 'running') return empty;
  // A remote server runs before its first install: its missing services are not an error, and
  // preparing it installs them. One that cannot be asked falls through to the error below.
  if (!(await guest.servicesInstalled().catch(() => true))) return empty;
  try {
    // The credential reads fail while the vault is locked (a restarted guest). That is a state of
    // its own, not an error: the credentials are still there, and preparing unlocks it.
    const failures: unknown[] = [];
    const credentials = <T>(p: Promise<T>) =>
      p.catch((err: unknown) => {
        failures.push(err);
        return undefined;
      });
    const [vault, codex, claude, hermes, connectors, base, workspaces, guestVersion] =
      await Promise.all([
        guest.vaultStatus(),
        credentials(codexStatus(guest)),
        credentials(claudeStatus(guest)),
        // A guest installed before Hermes support has no hermes_admin.py.
        hermesStatus(guest).catch(() => empty.hermes!),
        credentials(connectorStatuses(guest)),
        guest.imageStatus('codex', 'base').catch(() => false),
        guest.workspacesMounted().catch(() => false),
        guest.version().catch(() => null),
      ]);
    const runtimes: RuntimeId[] = ['codex', 'claude-code', 'hermes'];
    const prepared = base
      ? await Promise.all(
          runtimes.map(async (runtime) =>
            (await guest.imageStatus(`runtime-${runtime}`, 'runtime').catch(() => false))
              ? runtime
              : null,
          ),
        )
      : [];
    const installation = {
      preparedRuntimes: prepared.filter((runtime): runtime is RuntimeId => runtime !== null),
      vm,
      installed: base,
      workspaces,
      guestVersion,
      // Until the base image is built, installing is the next step anyway. A guest too old to
      // say its version is older than this Anchi.
      guestOutdated: base && guestVersion !== APP_VERSION,
    };
    if (!vault.unlocked) return { ...empty, ...installation, vaultUnlocked: false };
    if (failures.length) throw failures[0];
    const svc = (await services?.status().catch(() => undefined)) ?? {
      services: [],
      googleClient: false,
      xClient: false,
      redditClient: false,
      googleClientSource: null,
    };
    return {
      ...empty,
      ...installation,
      vaultUnlocked: true,
      codex: codex!,
      claude: claude!,
      hermes,
      connectors: connectors!,
      services: svc.services,
      googleClient: svc.googleClient,
      xClient: svc.xClient,
      redditClient: svc.redditClient,
      googleClientSource: svc.googleClientSource,
    };
  } catch (err) {
    // The guest runs but a command failed (sudo, a missing script): say so instead of showing
    // everything as not installed.
    return { ...empty, error: (err as Error).message.slice(0, 300) };
  }
}

/** Re-read after every completed step, so a failed or interrupted run can safely resume. */
export async function prepareEnvironment(
  runtime: RuntimeId,
  status: () => Promise<SetupStatus>,
  run: (action: SetupAction) => Promise<void>,
  prepareRuntime: (runtime: RuntimeId) => Promise<void>,
): Promise<SetupStatus> {
  let current = await status();
  if (current.host?.missing.length) {
    throw new Error(`Missing: ${current.host.missing.join(', ')}. ${current.host.installHint}`);
  }
  if (current.vm === 'unknown')
    throw new Error('Cannot determine the guest state; check setup status and retry.');
  if (current.vm === 'stopped') {
    await run('vm-start');
    current = await status();
  }
  if (current.error) throw new Error(current.error);
  if (current.vm === 'missing' || !current.installed || current.guestOutdated) {
    await run('install');
    current = await status();
  }
  if (current.error || current.vm !== 'running' || !current.installed || current.guestOutdated) {
    throw new Error(current.error ?? 'Environment preparation did not finish; retry setup.');
  }
  if (!current.vaultUnlocked) {
    await run(current.vaultKeyPresent === false ? 'vault-init' : 'vault-unlock');
    current = await status();
    if (current.error || !current.vaultUnlocked)
      throw new Error(current.error ?? 'Vault remains locked.');
  }
  if (!current.preparedRuntimes?.includes(runtime)) await prepareRuntime(runtime);
  current = await status();
  if (current.error || !current.vaultUnlocked || !current.preparedRuntimes?.includes(runtime)) {
    throw new Error(current.error ?? `Preparation of ${runtime} did not finish; retry setup.`);
  }
  return current;
}
