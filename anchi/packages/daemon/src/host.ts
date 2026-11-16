import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SetupAction } from '@anchi/protocol';

/** Both release bundles live in <root>/lib; source modules live in the workspace. */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  import.meta.url.endsWith('.mjs') ? '..' : '../../../..',
);

/** This Anchi's version: the release manifest, or the workspace package in a checkout. */
export function appVersion(root = REPO_ROOT): string {
  for (const file of ['manifest.json', 'anchi/package.json']) {
    try {
      const { version } = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
        version?: unknown;
      };
      if (typeof version === 'string' && version) return version;
    } catch {
      // Not this file; a checkout has no manifest.
    }
  }
  return 'unknown';
}

export const APP_VERSION = appVersion();

/** A release bundle carries its manifest and updater; a checkout has neither. */
export function installKind(root = REPO_ROOT): 'release' | 'source' {
  return existsSync(join(root, 'manifest.json')) && existsSync(join(root, 'scripts/update.sh'))
    ? 'release'
    : 'source';
}

/** The vault's master key on this computer; scripts/vault.mjs sends it to the vault over stdin. */
export const VAULT_KEY = join(homedir(), '.config/anchi/vault.key');

/**
 * scripts/vault.mjs in its own short process with this daemon's Node, so the master key is never
 * in the daemon's memory, and with core dumps off, so it is never written to disk either.
 */
function vaultStep(action: 'init' | 'unlock'): string[] {
  return [
    '/bin/sh',
    '-c',
    'ulimit -c 0 && exec "$0" "$@"',
    process.execPath,
    'scripts/vault.mjs',
    action,
  ];
}
const VAULT_UNLOCK = vaultStep('unlock');

/**
 * The steps of a daemon that runs inside the guest (`ANCHI_GUEST=local`, a remote server), fixed
 * host commands run from the checkout in order: the scripts install onto this machine, which is
 * always running, so there is nothing to start.
 */
export const IN_GUEST_SETUP_STEPS: Partial<Record<SetupAction, string[][]>> = {
  install: [
    ['bash', 'scripts/up.sh'],
    ['bash', 'scripts/install-anchi.sh'],
    ['sudo', '-n', 'anchi-image', 'build', 'codex', 'base'],
  ],
  'vault-init': [vaultStep('init')],
  'vault-unlock': [VAULT_UNLOCK],
};

/**
 * The steps of a daemon without a guest (`ANCHI_GUEST=host`, the default): nothing to install
 * or start as a command (the daemon starts its services process itself after these steps), and
 * the vault steps run on this computer (vault.mjs, against that process).
 */
export const HOST_SETUP_STEPS: Partial<Record<SetupAction, string[][]>> = {
  'vm-start': [],
  install: [],
  'vault-init': [vaultStep('init')],
  'vault-unlock': [VAULT_UNLOCK],
};

const STEP_TIMEOUT_MS = 45 * 60_000;

/** Runs one setup step at a time, streaming its output lines. */
export class SetupRunner {
  running: SetupAction | undefined;

  constructor(
    private steps: Partial<Record<SetupAction, string[][]>> = HOST_SETUP_STEPS,
    private cwd = REPO_ROOT,
    /** How long one command may run (tests shorten it). */
    private stepTimeoutMs = STEP_TIMEOUT_MS,
  ) {}

  async run(action: SetupAction, onLine: (line: string) => void): Promise<void> {
    if (this.running) throw new Error(`setup step "${this.running}" is already running`);
    const steps = this.steps[action];
    if (!steps) throw new Error(`setup step "${action}" does not apply to a remote server`);
    this.running = action;
    try {
      for (const [cmd, ...args] of steps) {
        onLine(`$ ${[cmd, ...args].join(' ')}`);
        const { code, last, timedOut } = await runLines(
          cmd!,
          args,
          this.cwd,
          onLine,
          this.stepTimeoutMs,
        );
        if (timedOut) {
          const limit =
            this.stepTimeoutMs >= 60_000
              ? `${Math.round(this.stepTimeoutMs / 60_000)} minutes`
              : `${Math.ceil(this.stepTimeoutMs / 1000)} s`;
          throw new Error(
            `${action} failed: ${[cmd, ...args].join(' ')} did not finish within ${limit} and was stopped${last ? ` (last output: ${last})` : ''}`,
          );
        }
        if (code !== 0) {
          throw new Error(`${action} failed: ${cmd} exited with ${code}${last ? `: ${last}` : ''}`);
        }
      }
    } finally {
      this.running = undefined;
    }
  }
}

function runLines(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<{ code: number; last: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANCHI_NODE: process.execPath },
    });
    let last = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => {
        const text = line.slice(0, 2000);
        if (text.trim()) last = text.trim().slice(0, 300);
        onLine(text);
      });
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: 127, last: err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, last, timedOut });
    });
  });
}

/** stdout of a short host command; its stderr is reported on failure. */
export function hostOutput(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not installed' : '';
        fail(new Error(`${cmd} ${args[0] ?? ''} failed: ${reason || stderr.trim().slice(-300)}`));
      } else {
        done(stdout);
      }
    });
  });
}

/** The token the host GitHub CLI is logged in with. */
export async function ghToken(run = hostOutput): Promise<string> {
  const token = (await run('gh', ['auth', 'token'])).trim();
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) {
    throw new Error('gh is not logged in; run `gh auth login` on this Mac');
  }
  return token;
}

export const AWS_PROFILE = /^[A-Za-z0-9_.+=,@-]{1,64}$/;

export interface AwsExport {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  /** ms since the epoch; null for long-lived keys. */
  expiresAt: number | null;
}

/**
 * Temporary credentials of a host AWS profile. The AWS CLI resolves the profile (SSO, assumed
 * role or credential process) and refreshes an SSO token itself while the SSO session lasts.
 */
export async function awsExport(profile: string, run = hostOutput): Promise<AwsExport> {
  if (!AWS_PROFILE.test(profile)) throw new Error('invalid AWS profile name');
  const raw = await run('aws', [
    'configure',
    'export-credentials',
    '--profile',
    profile,
    '--format',
    'process',
  ]);
  const value = JSON.parse(raw) as Record<string, string | undefined>;
  if (!value.AccessKeyId || !value.SecretAccessKey) {
    throw new Error(`profile ${profile} did not export credentials`);
  }
  const region = (
    await run('aws', ['configure', 'get', 'region', '--profile', profile]).catch(() => '')
  ).trim();
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new Error(`set a region for profile ${profile}: aws configure set region … --profile`);
  }
  return {
    accessKeyId: value.AccessKeyId,
    secretAccessKey: value.SecretAccessKey,
    ...(value.SessionToken ? { sessionToken: value.SessionToken } : {}),
    region,
    expiresAt: value.Expiration ? Date.parse(value.Expiration) : null,
  };
}

/** Non-secret connector settings kept by the daemon (the AWS profile it refreshes). */
export interface HostConnectors {
  aws?: { profile: string; expiresAt: number | null };
}

export function readHostConnectors(file: string): HostConnectors {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HostConnectors;
  } catch {
    return {};
  }
}

export function writeHostConnectors(file: string, value: HostConnectors): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function hostConnectorsFile(root: string): string {
  return join(root, 'data', 'connectors.json');
}
