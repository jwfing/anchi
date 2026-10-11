import { execFile, spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export const WORKSPACE_MOUNT = '/mnt/anchi-host';

/** The Lima VM (`secure-vm` before 0.3; scripts/vm-name.sh renames it). */
export const VM_NAME = 'anchi-vm';

/** The vault's master key on this computer; vault.py sends it to the VM over stdin. */
export const VAULT_KEY = join(homedir(), '.config/anchi/vault.key');

/**
 * How ~/AnchiWorkspaces reaches the VM. macOS: virtiofs at the mount itself, where files show as
 * owned by their reader. Linux: 9p, where the guest checks the host owner's uid, at a raw share
 * only root reaches; the guest's anchi-workspaces.service maps it onto the mount for the cell
 * agent with bindfs, and installing the guest pieces brings that service and starts it.
 */
export function workspaceSteps(platform: NodeJS.Platform = process.platform): string[][] {
  const linux = platform === 'linux';
  const mountPoint = linux ? '/mnt/anchi-host-raw/share' : WORKSPACE_MOUNT;
  return [
    ['mkdir', '-p', join(homedir(), 'AnchiWorkspaces')],
    ['limactl', 'stop', VM_NAME],
    [
      'limactl',
      'edit',
      VM_NAME,
      '--tty=false',
      '--set',
      `.mounts=[{"location":"~/AnchiWorkspaces","mountPoint":"${mountPoint}","writable":true}]`,
      '--set',
      `.mountType="${linux ? '9p' : 'virtiofs'}"`,
    ],
    ['limactl', 'start', '--tty=false', VM_NAME],
    ...(linux ? [['bash', 'scripts/install-anchi.sh']] : []),
    ['python3', 'scripts/vault.py', 'unlock'],
  ];
}

/** Fixed host commands per setup step, run from the checkout in order. */
export const SETUP_STEPS: Record<SetupAction, string[][]> = {
  // Mounts ~/AnchiWorkspaces into the VM once; restarts the VM, which locks the vault, so it is
  // unlocked again at the end.
  workspaces: workspaceSteps(),
  'vm-start': [['limactl', 'start', '--tty=false', VM_NAME]],
  install: [
    ['bash', 'scripts/up.sh'],
    ['bash', 'scripts/install-anchi.sh'],
    ['limactl', 'shell', VM_NAME, '--', 'sudo', '-n', 'anchi-image', 'build', 'codex', 'base'],
  ],
  // vault.py reads the master key from ~/.config/anchi and sends it to the VM over stdin.
  'vault-init': [['python3', 'scripts/vault.py', 'init']],
  'vault-unlock': [['python3', 'scripts/vault.py', 'unlock']],
};

/**
 * `setup.reset`: deletes the VM and everything in it (the vault's encrypted files included).
 * Lima ignores an instance that does not exist. The vault key and Anchi home are the CLI's.
 */
export const RESET_STEPS: string[][] = [['limactl', 'delete', '--force', VM_NAME]];

const STEP_TIMEOUT_MS = 45 * 60_000;

/**
 * Renames a VM created as `secure-vm` to `anchi-vm` and moves the vault key to ~/.config/anchi
 * (`scripts/vm-name.sh migrate`), restarting and unlocking a running VM. Nothing happens when
 * there is nothing to move. Its messages go to `log`; it never throws.
 */
export function migrateLegacyVm(log: (line: string) => void, cwd = REPO_ROOT): Promise<void> {
  return new Promise((done) => {
    const child = spawn('bash', ['scripts/vm-name.sh', 'migrate'], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    createInterface({ input: child.stderr }).on('line', (line) => log(`vm migration: ${line}`));
    child.on('error', (err) => log(`vm migration skipped: ${err.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code) log(`vm migration failed (exit ${code}); scripts/anchi setup install retries it`);
      done();
    });
  });
}

/** Runs one setup step at a time, streaming its output lines. */
export class SetupRunner {
  running: SetupAction | 'reset' | undefined;

  constructor(
    private steps: Record<SetupAction, string[][]> = SETUP_STEPS,
    private cwd = REPO_ROOT,
    private resetSteps: string[][] = RESET_STEPS,
  ) {}

  async run(action: SetupAction | 'reset', onLine: (line: string) => void): Promise<void> {
    if (this.running) throw new Error(`setup step "${this.running}" is already running`);
    if (action === 'workspaces' && process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error('workspaces are available on macOS and Linux hosts only');
    }
    this.running = action;
    try {
      for (const [cmd, ...args] of action === 'reset' ? this.resetSteps : this.steps[action]) {
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
