import { execFile, spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SetupAction } from '@anchi/protocol';

/** The checkout the daemon runs from; setup steps use its scripts. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const WORKSPACE_MOUNT = '/mnt/anchi-host';

/** Fixed host commands per setup step, run from the checkout in order. */
export const SETUP_STEPS: Record<SetupAction, string[][]> = {
  // Mounts ~/AnchiWorkspaces into the VM once (virtiofs, macOS); restarts the VM, which locks
  // the vault, so it is unlocked again at the end.
  workspaces: [
    ['mkdir', '-p', join(homedir(), 'AnchiWorkspaces')],
    ['limactl', 'stop', 'secure-vm'],
    [
      'limactl',
      'edit',
      'secure-vm',
      '--tty=false',
      '--set',
      `.mounts=[{"location":"~/AnchiWorkspaces","mountPoint":"${WORKSPACE_MOUNT}","writable":true}]`,
      '--set',
      '.mountType="virtiofs"',
    ],
    ['limactl', 'start', '--tty=false', 'secure-vm'],
    ['python3', 'scripts/vault.py', 'unlock'],
  ],
  'vm-start': [['limactl', 'start', '--tty=false', 'secure-vm']],
  install: [
    ['bash', 'scripts/up.sh'],
    ['bash', 'scripts/install-anchi.sh'],
    ['limactl', 'shell', 'secure-vm', '--', 'sudo', '-n', 'anchi-image', 'build', 'codex', 'base'],
  ],
  // vault.py reads the master key from ~/.config/secure-vm and sends it to the VM over stdin.
  'vault-init': [['python3', 'scripts/vault.py', 'init']],
  'vault-unlock': [['python3', 'scripts/vault.py', 'unlock']],
};

const STEP_TIMEOUT_MS = 45 * 60_000;

/** Runs one setup step at a time, streaming its output lines. */
export class SetupRunner {
  running: SetupAction | undefined;

  constructor(
    private steps: Record<SetupAction, string[][]> = SETUP_STEPS,
    private cwd = REPO_ROOT,
  ) {}

  async run(action: SetupAction, onLine: (line: string) => void): Promise<void> {
    if (this.running) throw new Error(`setup step "${this.running}" is already running`);
    if (action === 'workspaces' && process.platform !== 'darwin') {
      throw new Error('workspaces are available on macOS only for now');
    }
    this.running = action;
    try {
      for (const [cmd, ...args] of this.steps[action]) {
        onLine(`$ ${[cmd, ...args].join(' ')}`);
        const { code, last } = await runLines(cmd!, args, this.cwd, onLine);
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
): Promise<{ code: number; last: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), STEP_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => {
        const text = line.slice(0, 2000);
        if (text.trim()) last = text.trim().slice(0, 300);
        onLine(text);
      });
    }
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: 127, last: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, last });
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
