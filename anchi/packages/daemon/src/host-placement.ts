import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, homedir, totalmem } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HomeLayout } from '@anchi/core';
import { type ClientRequest, ControlClient } from '@anchi/host-services/client';
import { type HostServicesPaths, hostServicesPaths } from '@anchi/host-services/paths';
import type { HostStatus } from '@anchi/protocol';
import type { ExecResult, VmTransport } from './guest.ts';
import { APP_VERSION, REPO_ROOT } from './host.ts';

/**
 * The host placement: no VM. The egress proxy, the vault and the approvals queue run on this
 * computer as the user in one process the daemon starts (`@anchi/host-services`), and the
 * user's own Claude Code and Codex reach the proxy from inside their sandboxes
 * (docs/architecture/HOST_PLACEMENT_PLAN.md). Everything lives under ~/.anchi/host.
 */

/** The loopback port the user's runtimes are pointed at (Codex's own proxy takes 3128). */
export const HOST_PORT_DEFAULT = 18180;
export const PROXY_CONNECTORS = [
  'github',
  'aws',
  'linear',
  'posthog',
  'sentry',
  'firecrawl',
  'figma',
  'discord',
] as const;
const PLACEHOLDER = 'anchi-placeholder';
const PLACEHOLDER_COMPACT = 'anchiplaceholder';
const PORT = /^\d{4,5}$/;
const CLAUDE_BLOCK = 'sandbox';
const CODEX_MARK = 'anchi host placement';
const CODEX_BEGIN = `# >>> ${CODEX_MARK} >>>`;
const CODEX_END = `# <<< ${CODEX_MARK} <<<`;
const CODEX_LINE = `default_permissions = "anchi" # ${CODEX_MARK}`;

/** The services' layout plus what the daemon keeps beside it. */
export interface HostPaths extends HostServicesPaths {
  /** System roots plus the proxy's CA, written by the services; the sessions trust it. */
  caBundle: string;
  profile: string;
  manifest: string;
  bin: string;
}

export function hostPaths(layout: HomeLayout): HostPaths {
  const services = hostServicesPaths(join(layout.root, 'host'));
  return {
    ...services,
    caBundle: services.bundle,
    profile: join(services.root, 'profile.json'),
    manifest: join(services.root, 'managed.json'),
    bin: join(services.root, 'bin'),
  };
}

/** The `openssl` command line, which the services sign their certificates with. */
export function opensslAvailable(path = process.env.PATH ?? ''): boolean {
  return path.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, 'openssl'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** What the user chose for their host sessions (`~/.anchi/host/profile.json`). */
export interface HostProfile {
  port: number;
  /** Connectors whose every write waits for approval, as an agent's `approvals: ask`. */
  ask: string[];
  /** Hosts the sessions may reach, or null for any public host. */
  egress: string[] | null;
}

export function readProfile(paths: HostPaths): HostProfile {
  const profile: HostProfile = { port: HOST_PORT_DEFAULT, ask: [], egress: null };
  try {
    const raw = JSON.parse(readFileSync(paths.profile, 'utf8')) as Partial<HostProfile>;
    if (Number.isInteger(raw.port) && raw.port! >= 1024 && raw.port! <= 65535)
      profile.port = raw.port!;
    if (Array.isArray(raw.ask))
      profile.ask = raw.ask.filter((c): c is string => PROXY_CONNECTORS.includes(c as never));
    if (Array.isArray(raw.egress))
      profile.egress = raw.egress.filter((h): h is string => typeof h === 'string').slice(0, 100);
  } catch {
    // No profile yet: the defaults.
  }
  return profile;
}

/** Writes `text` to `file` through a temporary file and a rename. */
function replace(file: string, text: string, mode = 0o600): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const temporary = `${file}.anchi-new`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, file);
}

// ── guest commands on the host ─────────────────────────────

/** How to start the services and their CLI: the release bundles beside the daemon, else the sources on tsx. */
export interface HostCommand {
  services: string[];
  cli: string[];
}

export function hostCommand(): HostCommand {
  if (import.meta.url.endsWith('.mjs')) {
    const lib = dirname(fileURLToPath(import.meta.url));
    return {
      services: [process.execPath, join(lib, 'host-services.mjs')],
      cli: [process.execPath, join(lib, 'host-vault.mjs')],
    };
  }
  const tsx = createRequire(import.meta.url).resolve('tsx');
  const src = join(REPO_ROOT, 'anchi/packages/host-services/src');
  return {
    services: [process.execPath, '--import', tsx, join(src, 'main.ts')],
    cli: [process.execPath, '--import', tsx, join(src, 'cli.ts')],
  };
}

const NOT_CONFIGURED: Record<string, unknown> = {
  'codex_admin.py': { configured: false, account_id: null, expires_at: null },
  'claude_admin.py': { configured: false, kind: null, expires_at: null },
  'hermes_admin.py': { configured: false, base_url: null, model: null },
};

/**
 * The fixed guest commands the daemon runs, answered by the services over the control socket
 * (`anchi-cell …` and the admin scripts) or by a canned answer where the host has no
 * counterpart: images are always present (nothing to build), the runtimes stay the user's own
 * logins, and nothing else runs. Output is one JSON line, as the guest's commands print it.
 */
export async function hostExec(
  args: string[],
  stdin: string,
  call: (request: ClientRequest) => Promise<unknown>,
): Promise<ExecResult> {
  const ok = (value: unknown): ExecResult => ({
    code: 0,
    stdout: JSON.stringify(value),
    stderr: '',
  });
  const no = (code: string): ExecResult => ({
    code: 1,
    stdout: JSON.stringify({ error: code }),
    stderr: '',
  });
  const input = (): Record<string, unknown> => {
    const value: unknown = JSON.parse(stdin || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_REQUEST');
    return value as Record<string, unknown>;
  };
  const [command, second, third, fourth, fifth] = args;
  try {
    if (command === 'anchi-cell') {
      if (second === 'version') return ok(await call({ op: 'version' }));
      if (second === 'list') return ok({ cells: [] });
      if (second === 'reap') return ok({ reaped: [] });
      if (second === 'quota') return ok(await call({ op: 'quota' }));
      if (second === 'verify' && third)
        return ok(await call({ op: 'verify', connector: third as never }));
      if (second === 'egress-settings')
        return ok(await call({ op: 'settings.set', settings: input() as never }));
      if (second === 'register')
        return ok(await call({ op: 'register', ...(input() as object) } as never));
      if (second === 'unregister') return ok(await call({ op: 'unregister' }));
      if (
        second === 'approvals' &&
        third === 'decide' &&
        fourth &&
        (fifth === 'allow' || fifth === 'deny')
      )
        return ok(await call({ op: 'approvals.decide', id: fourth, allow: fifth === 'allow' }));
      return no('HOST_PLACEMENT');
    }
    if (command === 'anchi-image' && second === 'status') return ok({ present: true });
    if (command === 'anchi-image' && second === 'build')
      return ok({ image: third, hash: fourth, reused: true });
    if (command === 'test' && second === '-f') return { code: 0, stdout: '', stderr: '' };
    if (command === 'mountpoint') return { code: 1, stdout: '', stderr: '' };
    if (command === '/usr/bin/python3' && typeof second === 'string') {
      const script = second.slice(second.lastIndexOf('/') + 1);
      if (script === 'vault_admin.py' && third === 'status')
        return ok(await call({ op: 'vault.status' }));
      if (script === 'admin.py') {
        if (third === 'status') return ok(await call({ op: 'credentials.status' }));
        if (third === 'import-token' && fourth)
          return ok(
            await call({
              op: 'credentials.import',
              connector: fourth as never,
              value: String(input().token ?? ''),
            }),
          );
        if (third === 'import-aws' && fourth === 'aws') {
          const v = input();
          return ok(
            await call({
              op: 'credentials.importAws',
              access_key_id: String(v.access_key_id ?? ''),
              secret_access_key: String(v.secret_access_key ?? ''),
              region: String(v.region ?? ''),
              ...(typeof v.session_token === 'string' ? { session_token: v.session_token } : {}),
            }),
          );
        }
        if (third === 'disconnect' && fourth)
          return ok(await call({ op: 'credentials.remove', connector: fourth as never }));
        if (third === 'set-account' && fourth)
          return ok(
            await call({
              op: 'credentials.setAccount',
              connector: fourth as never,
              label: String(input().account ?? ''),
            }),
          );
      }
      if (script in NOT_CONFIGURED && third === 'status') return ok(NOT_CONFIGURED[script]);
    }
    return no('HOST_PLACEMENT');
  } catch (err) {
    // The services' codes (`VAULT_LOCKED`, `BAD_TOKEN_FORMAT`, …) reach the daemon as the guest's would.
    return no(String((err as Error).message).slice(0, 120));
  }
}

/** A child that prints a canned answer, for callers that own a process's stdio. */
function answerChild(answer: ExecResult): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      '-e',
      'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exitCode = Number(process.argv[3]);',
      answer.stdout,
      answer.stderr,
      String(answer.code),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

export class HostTransport implements VmTransport {
  readonly placement = 'host';
  readonly client: ControlClient;

  constructor(
    readonly paths: HostPaths,
    readonly command: HostCommand = hostCommand(),
  ) {
    this.client = new ControlClient(paths.control, paths.token);
  }

  /** This computer can run the services: nothing to install beyond the `openssl` command. */
  installed(): boolean {
    return opensslAvailable();
  }

  /** The services process is up: its control socket and token are there. */
  running(): boolean {
    return existsSync(this.paths.control) && existsSync(this.paths.token);
  }

  /** Only the approval stream is a long-running command; the CLI relays it from the services. */
  spawn(args: string[]): ChildProcessWithoutNullStreams {
    if (args[0] === 'anchi-cell' && args[1] === 'approvals' && args[2] === 'watch') {
      const [bin, ...rest] = this.command.cli;
      return spawn(bin!, [...rest, '--root', this.paths.root, 'approvals', 'watch'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    return answerChild({
      code: 1,
      stdout: JSON.stringify({ error: 'HOST_PLACEMENT' }),
      stderr: '',
    });
  }

  exec(args: string[], stdin = '', timeoutMs = 120_000): Promise<ExecResult> {
    return hostExec(args, stdin, (request) => this.client.call(request, timeoutMs));
  }

  /** `running` while the services answer; `stopped` otherwise. There is no machine to start. */
  async vmStatus(): Promise<'running' | 'stopped'> {
    return this.running() ? 'running' : 'stopped';
  }
}

// ── the services process ──────────────────────────────────

const RESTART_MS = 3_000;

/**
 * The services process (`@anchi/host-services`: the proxy, the vault, the approvals queue),
 * started when the daemon starts and started again when it exits, until `stop`. It writes its
 * control socket and the CA bundle under ~/.anchi/host; the daemon never holds a credential.
 */
export class HostServices {
  private child?: ChildProcessWithoutNullStreams;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private transport: HostTransport,
    private log: (line: string) => void = () => {},
    private startTimeoutMs = 30_000,
    /** Called whenever a (re)started process answers: the daemon registers the principal again. */
    private onReady?: () => void,
  ) {}

  get paths(): HostPaths {
    return this.transport.paths;
  }

  running(): boolean {
    return this.transport.running();
  }

  async start(): Promise<void> {
    if (!this.transport.installed())
      throw new Error('HOST_NOT_INSTALLED: the openssl command line is required');
    this.stopped = false;
    mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    rmSync(this.paths.control, { force: true });
    this.keep();
    const started = Date.now();
    while (!this.running()) {
      if (!this.child || Date.now() - started > this.startTimeoutMs)
        throw new Error('HOST_SERVICES_TIMEOUT: the services did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Starts the process and starts it again when it ends, until `stop`. */
  private keep(): void {
    const [bin, ...rest] = this.transport.command.services;
    // `--parent`: the services end themselves when this daemon is gone, so a crash leaves no
    // orphan holding the sessions' port.
    const child = spawn(
      bin!,
      [
        ...rest,
        '--root',
        this.paths.root,
        '--version',
        APP_VERSION,
        '--parent',
        String(process.pid),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    child.stdin.end();
    void this.awaitReady(child);
    child.stdout.on('data', () => {});
    let tail = '';
    child.stderr.on('data', (b: Buffer) => {
      tail = (tail + b.toString('utf8')).slice(-400);
    });
    child.on('error', (err) => this.log(`host services: ${err.message}`));
    child.on('close', (code) => {
      this.child = undefined;
      if (this.stopped) return;
      this.log(`host services exited (${code}): ${tail.trim().split('\n').at(-1) ?? ''}`);
      this.timer = setTimeout(() => this.keep(), RESTART_MS);
      this.timer.unref();
    });
  }

  /** Waits for this child's control socket, then tells the daemon, unless the child is gone. */
  private async awaitReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    const started = Date.now();
    while (this.child === child && !this.running()) {
      if (Date.now() - started > this.startTimeoutMs) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (this.child === child && !this.stopped) this.onReady?.();
  }

  /** Registers the host principal with the proxy: its connectors, approvals and port. */
  async register(connectors: string[], profile: HostProfile): Promise<void> {
    const r = await this.transport.exec(
      ['anchi-cell', 'register'],
      JSON.stringify({
        connectors: connectors.filter((c) => PROXY_CONNECTORS.includes(c as never)),
        ask: profile.ask,
        egress: profile.egress,
        listen_port: profile.port,
      }),
    );
    if (r.code !== 0) throw new Error(`host registration failed: ${r.stdout.trim().slice(0, 200)}`);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.child?.kill();
    this.child = undefined;
  }
}

// ── the runtimes' settings ────────────────────────────────

export interface HostSpec {
  port: number;
  caBundle: string;
  caCert: string;
  /** Paths sandboxed commands may not read; the vault and keys are always among them. */
  denyRead: string[];
}

/**
 * The files a session's commands must not read: the vault, the CA key and the control token
 * (all under `state`), the vault key and credential stores. The rest of `~/.anchi/host` stays
 * readable: the trust bundle, which the sandboxed tools verify the proxy's certificates with,
 * the shims, the profile and the audit log.
 */
export function denyReadPaths(paths: HostPaths, home = homedir()): string[] {
  return [
    paths.state,
    join(home, '.config/anchi'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.config/gh'),
    join(home, '.netrc'),
  ];
}

/** The trust variables Anchi sets; the restore walks this list, since JSON keeps no `undefined`. */
const CA_KEYS = [
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'REQUESTS_CA_BUNDLE',
  'AWS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
] as const;

// Every tool gets the bundle (the system roots plus the proxy's CA): the CA certificate alone
// lies under the denied state directory.
const CA_ENV = (spec: HostSpec): Record<string, string> =>
  Object.fromEntries(CA_KEYS.map((k) => [k, spec.caBundle]));

/** What Anchi set in a settings file, with what was there before, so it can be undone. */
export interface ClaudeManaged {
  previousSandbox: unknown;
  previousEnv: Record<string, string | undefined>;
}

/**
 * `~/.claude/settings.json` with Anchi's sandbox and trust settings merged in. Refuses a file
 * whose `sandbox` block Anchi did not write (`managed` absent): the user's own sandbox
 * settings are theirs to change. Reports `excludedCommands`, which run outside the sandbox.
 */
export function claudeSettingsText(
  existing: string | undefined,
  spec: HostSpec,
  managed?: ClaudeManaged,
): { text: string; managed: ClaudeManaged; excludedCommands: string[] } {
  let value: Record<string, unknown>;
  try {
    value = existing?.trim() ? (JSON.parse(existing) as Record<string, unknown>) : {};
  } catch {
    throw new Error('CLAUDE_SETTINGS_UNREADABLE: settings.json is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('CLAUDE_SETTINGS_UNREADABLE: settings.json is not an object');
  if (CLAUDE_BLOCK in value && !managed)
    throw new Error(
      'CLAUDE_SETTINGS_HAS_SANDBOX: settings.json already has a sandbox block; remove it or keep your own',
    );
  const env = { ...((value.env as Record<string, unknown> | undefined) ?? {}) };
  const ours = CA_ENV(spec);
  const result: ClaudeManaged = managed ?? {
    previousSandbox: undefined,
    previousEnv: Object.fromEntries(
      Object.keys(ours).map((k) => [
        k,
        typeof env[k] === 'string' ? (env[k] as string) : undefined,
      ]),
    ),
  };
  const sandbox = {
    enabled: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    network: { httpProxyPort: spec.port },
    filesystem: { denyRead: spec.denyRead },
  };
  const previous = (value.sandbox as Record<string, unknown> | undefined) ?? {};
  const excluded = Array.isArray(previous.excludedCommands)
    ? previous.excludedCommands.filter((c): c is string => typeof c === 'string')
    : [];
  const text = `${JSON.stringify({ ...value, sandbox, env: { ...env, ...ours } }, null, 2)}\n`;
  return { text, managed: result, excludedCommands: excluded };
}

/** The settings file without what Anchi set, the previous values back in place. */
export function claudeSettingsRestored(
  existing: string | undefined,
  managed: ClaudeManaged,
): string {
  let value: Record<string, unknown>;
  try {
    value = existing?.trim() ? (JSON.parse(existing) as Record<string, unknown>) : {};
  } catch {
    throw new Error('CLAUDE_SETTINGS_UNREADABLE: settings.json is not valid JSON');
  }
  const env = { ...((value.env as Record<string, unknown> | undefined) ?? {}) };
  for (const k of CA_KEYS) {
    const before = managed.previousEnv[k];
    if (before === undefined) delete env[k];
    else env[k] = before;
  }
  const { sandbox: _dropped, env: _env, ...rest } = value;
  const restored: Record<string, unknown> = { ...rest };
  if (managed.previousSandbox !== undefined) restored.sandbox = managed.previousSandbox;
  if (Object.keys(env).length) restored.env = env;
  return `${JSON.stringify(restored, null, 2)}\n`;
}

const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The file without Anchi's block and its `default_permissions` line. */
function codexStripped(existing: string): string {
  const begin = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END);
  let text = existing;
  if (begin !== -1 && end !== -1 && end > begin) {
    text = `${existing.slice(0, begin)}${existing.slice(end + CODEX_END.length)}`;
  }
  return text
    .split('\n')
    .filter((line) => line !== CODEX_LINE)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * `~/.codex/config.toml` with Anchi's permission profile selected: a marked block at the end
 * (the profile, its filesystem denials, network through the proxy without SOCKS, and the
 * network proxy feature) and `default_permissions` at the top, where TOML wants a bare key.
 * Refuses a file that selects a profile, defines `permissions.anchi` or configures the network
 * proxy itself, since merging into TOML it did not write could change what the user meant.
 */
export function codexConfigText(existing: string | undefined, spec: HostSpec): string {
  const base = codexStripped(existing ?? '');
  const conflicts: [RegExp, string][] = [
    [/^\s*default_permissions\s*=/m, 'default_permissions is already set'],
    [/^\s*\[permissions\.anchi(\]|\.)/m, 'a permissions.anchi profile exists'],
    [/network_proxy/, 'network_proxy is already configured'],
  ];
  for (const [pattern, why] of conflicts) {
    if (pattern.test(base)) throw new Error(`CODEX_CONFIG_CONFLICT: ${why} in config.toml`);
  }
  const deny = spec.denyRead.map((p) => `${tomlString(p)} = "deny"`).join('\n');
  const block = [
    CODEX_BEGIN,
    '# Written by `anchi host enable`; `anchi host disable` removes it.',
    '[features.network_proxy]',
    'enabled = true',
    '',
    '[permissions.anchi]',
    'extends = ":workspace"',
    '',
    '[permissions.anchi.filesystem]',
    deny,
    '',
    '[permissions.anchi.network]',
    'enabled = true',
    'enable_socks5 = false',
    'allow_upstream_proxy = true',
    // The upstream is Anchi's proxy on loopback, which Codex's policy otherwise refuses as a
    // local address (verified with Codex 0.169); Anchi's proxy still refuses every non-public
    // destination, so a sandboxed command gains no private address through this.
    'allow_local_binding = true',
    '',
    // Codex's own proxy allows no destination until a rule exists; Anchi's proxy, the upstream
    // every request chains to, applies the egress list and the address check itself.
    '[permissions.anchi.network.domains]',
    '"*" = "allow"',
    CODEX_END,
    '',
  ].join('\n');
  const body = base.trim() ? `${base.trimEnd()}\n\n` : '';
  return `${CODEX_LINE}\n${body}${block}`;
}

export function codexConfigRestored(existing: string | undefined): string {
  const text = codexStripped(existing ?? '').trim();
  return text ? `${text}\n` : '';
}

/** The environment a shim gives the runtime: the proxy, the trust bundle and placeholders. */
export function shimEnvironment(
  spec: HostSpec,
  connectors: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {
    HTTPS_PROXY: `http://127.0.0.1:${spec.port}`,
    HTTP_PROXY: `http://127.0.0.1:${spec.port}`,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    ...CA_ENV(spec),
  };
  // The same placeholders as a cell's environment (guest/anchi_cell.py cell_environment).
  if (connectors.includes('github')) env.GH_TOKEN = `${PLACEHOLDER}-github`;
  if (connectors.includes('aws')) {
    env.AWS_ACCESS_KEY_ID = 'AKIAANCHIPLACEHOLDER';
    env.AWS_SECRET_ACCESS_KEY = `${PLACEHOLDER}-aws-secret`;
    env.AWS_EC2_METADATA_DISABLED = 'true';
  }
  if (connectors.includes('linear')) env.LINEAR_API_KEY = `lin_api_${PLACEHOLDER_COMPACT}0000`;
  if (connectors.includes('posthog'))
    env.POSTHOG_PERSONAL_API_KEY = `phx_${PLACEHOLDER_COMPACT}${'0'.repeat(24)}`;
  if (connectors.includes('sentry'))
    env.SENTRY_AUTH_TOKEN = `sntryu_${PLACEHOLDER_COMPACT}${'0'.repeat(48)}`;
  if (connectors.includes('firecrawl'))
    env.FIRECRAWL_API_KEY = `fc-${PLACEHOLDER_COMPACT}${'0'.repeat(16)}`;
  if (connectors.includes('figma')) env.FIGMA_ACCESS_TOKEN = `figd_${PLACEHOLDER}`;
  if (connectors.includes('discord'))
    env.DISCORD_BOT_TOKEN = `MTAwMDAwMDAwMDAwMDAwMDAw.AAAAAA.${PLACEHOLDER_COMPACT}${'0'.repeat(16)}`;
  return env;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A shim named like the runtime: sets the environment and runs the real command found later on
 * PATH. The runtime itself then reaches the model API through the proxy too, with the user's
 * own login, which the proxy passes untouched.
 */
export function shimText(name: string, env: Record<string, string>): string {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) throw new Error(`BAD_SHIM_NAME: ${name}`);
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
    .join('\n');
  return `#!/bin/bash
# Anchi host placement: this session reaches the network through Anchi's proxy, with placeholders
# instead of credentials. Written by \`anchi host enable\`; \`anchi host disable\` removes it.
here=$(cd "$(dirname "$0")" && pwd)
real=""
IFS=: read -ra dirs <<<"$PATH"
for dir in "\${dirs[@]}"; do
  [[ $dir == "$here" || $dir == "$here/" ]] && continue
  if [[ -x $dir/${name} ]]; then real=$dir/${name}; break; fi
done
[[ -n $real ]] || { echo "anchi: ${name} is not installed (not on PATH after $here)" >&2; exit 127; }
${exports}
exec "$real" "$@"
`;
}

// ── enable, disable, status ───────────────────────────────

interface Manifest {
  version: 1;
  claude: { file: string; managed: ClaudeManaged };
  codex: { file: string };
  shims: string[];
}

export interface HostFiles {
  claudeSettings: string;
  codexConfig: string;
}

export function hostFiles(home = homedir()): HostFiles {
  return {
    claudeSettings: join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'settings.json'),
    codexConfig: join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
  };
}

function readManifest(paths: HostPaths): Manifest | undefined {
  try {
    const value = JSON.parse(readFileSync(paths.manifest, 'utf8')) as Manifest;
    return value.version === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function hostSpec(paths: HostPaths, profile: HostProfile, home = homedir()): HostSpec {
  return {
    port: profile.port,
    caBundle: paths.caBundle,
    caCert: paths.caCert,
    denyRead: denyReadPaths(paths, home),
  };
}

/**
 * Writes the runtimes' settings and the shims, recording what it did in the manifest. Every
 * refusal happens before the first file changes.
 */
export function enableHost(
  paths: HostPaths,
  files: HostFiles,
  connectors: readonly string[],
  profile = readProfile(paths),
  home = homedir(),
): { excludedCommands: string[] } {
  if (!existsSync(paths.caBundle)) throw new Error('HOST_NOT_RUNNING: the proxy has no CA yet');
  const spec = hostSpec(paths, profile, home);
  const previous = readManifest(paths);
  const claude = claudeSettingsText(
    readText(files.claudeSettings),
    spec,
    previous?.claude.file === files.claudeSettings ? previous.claude.managed : undefined,
  );
  const codex = codexConfigText(readText(files.codexConfig), spec);
  const env = shimEnvironment(spec, connectors);
  const shims = ['claude', 'codex'].map((name) => ({ name, text: shimText(name, env) }));
  // Nothing refused: write, the manifest first so a failure mid-way can still be undone.
  const manifest: Manifest = {
    version: 1,
    claude: { file: files.claudeSettings, managed: claude.managed },
    codex: { file: files.codexConfig },
    shims: shims.map((s) => join(paths.bin, s.name)),
  };
  mkdirSync(paths.bin, { recursive: true, mode: 0o700 });
  replace(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  replace(files.claudeSettings, claude.text);
  replace(files.codexConfig, codex);
  for (const shim of shims) {
    replace(join(paths.bin, shim.name), shim.text, 0o700);
    chmodSync(join(paths.bin, shim.name), 0o700);
  }
  return { excludedCommands: claude.excludedCommands };
}

/** Undoes `enableHost`: the settings without Anchi's keys, no shims, no manifest. */
export function disableHost(paths: HostPaths): boolean {
  const manifest = readManifest(paths);
  if (!manifest) return false;
  const claude = readText(manifest.claude.file);
  if (claude !== undefined)
    replace(manifest.claude.file, claudeSettingsRestored(claude, manifest.claude.managed));
  const codex = readText(manifest.codex.file);
  if (codex !== undefined) {
    const restored = codexConfigRestored(codex);
    if (restored) replace(manifest.codex.file, restored);
    else rmSync(manifest.codex.file, { force: true });
  }
  for (const shim of manifest.shims) rmSync(shim, { force: true });
  rmSync(paths.manifest, { force: true });
  return true;
}

export function hostStatus(
  paths: HostPaths,
  files: HostFiles,
  connectors: string[],
  running: boolean,
  path = process.env.PATH ?? '',
): HostStatus {
  const manifest = readManifest(paths);
  const profile = readProfile(paths);
  const installed = opensslAvailable(path);
  const onPath = path.split(delimiter).some((d) => d === paths.bin || d === `${paths.bin}/`);
  const excluded = (() => {
    try {
      const value = JSON.parse(readText(files.claudeSettings) ?? '{}') as {
        sandbox?: { excludedCommands?: unknown };
      };
      return Array.isArray(value.sandbox?.excludedCommands)
        ? value.sandbox.excludedCommands.filter((c): c is string => typeof c === 'string')
        : [];
    } catch {
      return [];
    }
  })();
  return {
    placement: 'host',
    installed,
    running,
    enabled: manifest !== undefined,
    port: profile.port,
    ask: profile.ask,
    shimDir: paths.bin,
    shimOnPath: onPath,
    caBundle: paths.caBundle,
    claude: {
      file: files.claudeSettings,
      managed: manifest?.claude.file === files.claudeSettings,
      excludedCommands: excluded,
    },
    codex: { file: files.codexConfig, managed: manifest?.codex.file === files.codexConfig },
    missing: installed ? [] : ['openssl'],
    connectors,
  };
}

export { PORT };
