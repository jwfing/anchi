import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
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
import { createServer } from 'node:net';
import { cpus, homedir, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import type { HomeLayout } from '@anchi/core';
import type { HostStatus } from '@anchi/protocol';
import { collect, type ExecResult, type VmTransport } from './guest.ts';
import { REPO_ROOT } from './host.ts';

/**
 * The host placement: no VM. The egress proxy, the vault and its auth service run on this
 * computer as the user, started by the daemon, and the user's own Claude Code and Codex reach
 * the proxy from inside their sandboxes (docs/architecture/HOST_PLACEMENT_PLAN.md). Everything
 * lives under ~/.anchi/host; the Python side comes from scripts/host-install.sh.
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

export interface HostPaths {
  root: string;
  state: string;
  venv: string;
  python: string;
  mitmdump: string;
  run: string;
  /** The proxy's control socket, for host_control.py. */
  control: string;
  /** The auth service's socket for the proxy. */
  authSocket: string;
  mitm: string;
  caCert: string;
  caBundle: string;
  audit: string;
  profile: string;
  manifest: string;
  bin: string;
  installed: string;
}

export function hostPaths(layout: HomeLayout): HostPaths {
  const root = join(layout.root, 'host');
  const state = join(root, 'state');
  const venv = join(root, 'venv');
  return {
    root,
    state,
    venv,
    python: join(venv, 'bin/python'),
    mitmdump: join(venv, 'bin/mitmdump'),
    run: join(state, 'run'),
    control: join(state, 'run/egress/control.sock'),
    authSocket: join(state, 'run/auth-egress.sock'),
    mitm: join(state, 'mitm'),
    caCert: join(state, 'mitm/mitmproxy-ca-cert.pem'),
    caBundle: join(root, 'ca-bundle.pem'),
    audit: join(root, 'audit.jsonl'),
    profile: join(root, 'profile.json'),
    manifest: join(root, 'managed.json'),
    bin: join(root, 'bin'),
    installed: join(root, 'installed.json'),
  };
}

let pythonCache: { at: number; path: string | null } | undefined;

/** A Python 3.11+ on PATH for scripts/host-install.sh, or null. Cached for a minute. */
export function hostPython(path = process.env.PATH ?? ''): string | null {
  if (pythonCache && Date.now() - pythonCache.at < 60_000) return pythonCache.path;
  let found: string | null = null;
  for (const name of ['python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3']) {
    for (const dir of path.split(delimiter)) {
      const file = join(dir, name);
      try {
        accessSync(file, constants.X_OK);
      } catch {
        continue;
      }
      const res = spawnSync(file, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (res.status === 0 && res.stdout.trim() === 'True') {
        found = file;
        break;
      }
    }
    if (found) break;
  }
  pythonCache = { at: Date.now(), path: found };
  return found;
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

/** The scripts the daemon may run on the host; others have no host counterpart. */
const HOST_SCRIPTS = new Set(['vault_admin.py', 'admin.py', 'connector_admin.py']);
const NOT_CONFIGURED: Record<string, unknown> = {
  'codex_admin.py': { configured: false, account_id: null, expires_at: null },
  'claude_admin.py': { configured: false, kind: null, expires_at: null },
  'hermes_admin.py': { configured: false, base_url: null, model: null },
};

export type HostRoute = { argv: string[] } | { answer: ExecResult };

/**
 * The host command for a fixed guest command (`anchi-cell …` becomes host_control.py, the
 * admin scripts run from the checkout), or a canned answer where the host has no counterpart:
 * images are always present (nothing to build), the runtimes stay the user's own logins.
 */
export function hostRoute(args: string[], paths: HostPaths, servicesDir: string): HostRoute {
  const ok = (value: unknown): HostRoute => ({
    answer: { code: 0, stdout: JSON.stringify(value), stderr: '' },
  });
  const refused: HostRoute = {
    answer: { code: 1, stdout: JSON.stringify({ error: 'HOST_PLACEMENT' }), stderr: '' },
  };
  const installed = existsSync(paths.python);
  const [command, second] = args;
  if (command === 'anchi-cell')
    return { argv: [paths.python, join(servicesDir, 'host_control.py'), ...args.slice(1)] };
  if (command === 'anchi-image' && second === 'status') return ok({ present: installed });
  if (command === 'anchi-image' && second === 'build')
    return ok({ image: args[2], hash: args[3], reused: true });
  if (command === 'test' && second === '-f')
    return { answer: { code: installed ? 0 : 1, stdout: '', stderr: '' } };
  if (command === 'mountpoint') return { answer: { code: 1, stdout: '', stderr: '' } };
  if (command === '/usr/bin/python3' && typeof second === 'string') {
    const script = second.slice(second.lastIndexOf('/') + 1);
    if (HOST_SCRIPTS.has(script))
      return { argv: [paths.python, join(servicesDir, script), ...args.slice(2)] };
    if (script in NOT_CONFIGURED && args[2] === 'status') return ok(NOT_CONFIGURED[script]);
  }
  return refused;
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

  constructor(
    readonly paths: HostPaths,
    readonly servicesDir = join(REPO_ROOT, 'services'),
  ) {}

  /** scripts/host-install.sh ran: the venv has its Python and mitmproxy. */
  installed(): boolean {
    return existsSync(this.paths.python) && existsSync(this.paths.mitmdump);
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ANCHI_HOST_STATE: this.paths.state };
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    const route = hostRoute(args, this.paths, this.servicesDir);
    if ('answer' in route) return answerChild(route.answer);
    return spawn(route.argv[0]!, route.argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env(),
    });
  }

  exec(args: string[], stdin = '', timeoutMs = 120_000): Promise<ExecResult> {
    const route = hostRoute(args, this.paths, this.servicesDir);
    if ('answer' in route) return Promise.resolve(route.answer);
    return collect(this.spawn(args), stdin, timeoutMs);
  }

  /** `running` once installed: the services are the daemon's children, not a machine. */
  async vmStatus(): Promise<'running' | 'missing'> {
    return this.installed() ? 'running' : 'missing';
  }

  async vmSize(): Promise<{ cpus: number; memoryGiB: number }> {
    return { cpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30) };
  }
}

// ── the services, as the daemon's children ────────────────

const RESTART_MS = 3_000;
const START_TIMEOUT_MS = 30_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** The system's root certificates, which the proxy's CA is appended to for the sessions. */
export function systemRoots(platform = process.platform): string {
  return platform === 'darwin' ? '/etc/ssl/cert.pem' : '/etc/ssl/certs/ca-certificates.crt';
}

/**
 * The auth service (the vault's reader) and the egress proxy (mitmproxy with
 * services/egress_proxy.py), started when the daemon starts and restarted when they exit. Both
 * run as the user with their state under ~/.anchi/host/state; the proxy's own listener is a
 * loopback port chosen at start, and the sessions' port is a registered listener of its own.
 */
export class HostServices {
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private internalPort?: number;

  constructor(
    private transport: HostTransport,
    private log: (line: string) => void = () => {},
  ) {}

  private get paths(): HostPaths {
    return this.transport.paths;
  }

  running(): boolean {
    return existsSync(this.paths.control);
  }

  async start(): Promise<void> {
    if (!this.transport.installed()) throw new Error('HOST_NOT_INSTALLED: run anchi setup install');
    this.stopped = false;
    for (const dir of [this.paths.state, this.paths.run, join(this.paths.run, 'egress')]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    rmSync(this.paths.control, { force: true });
    this.internalPort ??= await freePort();
    this.keep('auth', () => this.spawnAuth());
    this.keep('proxy', () => this.spawnProxy(this.internalPort!));
    const started = Date.now();
    while (!existsSync(this.paths.control) || !existsSync(this.paths.caCert)) {
      if (Date.now() - started > START_TIMEOUT_MS)
        throw new Error('HOST_SERVICES_TIMEOUT: the egress proxy did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    this.writeBundle();
  }

  /** Starts a child and starts it again when it ends, until `stop`. */
  private keep(name: string, start: () => ChildProcessWithoutNullStreams): void {
    const child = start();
    this.children.set(name, child);
    child.stdin.end();
    child.stdout.on('data', () => {});
    let tail = '';
    child.stderr.on('data', (b: Buffer) => {
      tail = (tail + b.toString('utf8')).slice(-400);
    });
    child.on('error', (err) => this.log(`host ${name}: ${err.message}`));
    child.on('close', (code) => {
      this.children.delete(name);
      if (this.stopped) return;
      this.log(`host ${name} exited (${code}): ${tail.trim().split('\n').at(-1) ?? ''}`);
      const timer = setTimeout(() => this.keep(name, start), RESTART_MS);
      timer.unref();
      this.timers.push(timer);
    });
  }

  private spawnAuth(): ChildProcessWithoutNullStreams {
    return spawn(
      this.paths.python,
      [
        join(this.transport.servicesDir, 'server.py'),
        'auth',
        '--listen',
        `egress=${this.paths.authSocket}`,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ANCHI_HOST_STATE: this.paths.state },
      },
    );
  }

  private spawnProxy(port: number): ChildProcessWithoutNullStreams {
    const services = this.transport.servicesDir;
    return spawn(
      this.paths.mitmdump,
      [
        '--quiet',
        '-s',
        join(services, 'egress_proxy.py'),
        '--listen-host',
        '127.0.0.1',
        '--listen-port',
        String(port),
        '--set',
        `confdir=${this.paths.mitm}`,
        '--set',
        'stream_large_bodies=8m',
        '--set',
        'connection_strategy=lazy',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONPATH: services,
          ANCHI_EGRESS_HOST: '1',
          ANCHI_EGRESS_RUN: join(this.paths.run, 'egress'),
          ANCHI_EGRESS_AUDIT: this.paths.audit,
          ANCHI_EGRESS_AUTH: this.paths.authSocket,
          ANCHI_EGRESS_STATE: join(this.paths.state, 'egress'),
        },
      },
    );
  }

  /** System roots plus the proxy's CA: what the sessions' tools are told to trust. */
  writeBundle(): void {
    const roots = (() => {
      try {
        return readFileSync(systemRoots(), 'utf8');
      } catch {
        return '';
      }
    })();
    const ca = readFileSync(this.paths.caCert, 'utf8');
    replace(this.paths.caBundle, `${roots.trimEnd()}\n${ca.trim()}\n`, 0o644);
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
    for (const t of this.timers) clearTimeout(t);
    for (const child of this.children.values()) child.kill();
    this.children.clear();
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

/** The files a session's commands must not read: the vault, keys and credential stores. */
export function denyReadPaths(paths: HostPaths, home = homedir()): string[] {
  return [
    paths.root,
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

const CA_ENV = (spec: HostSpec): Record<string, string> =>
  Object.fromEntries(
    CA_KEYS.map((k) => [k, k === 'NODE_EXTRA_CA_CERTS' ? spec.caCert : spec.caBundle]),
  );

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
  const installed = existsSync(paths.python) && existsSync(paths.mitmdump);
  const python = hostPython(path);
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
    python,
    missing: python ? [] : ['python3 (3.11 or newer)'],
    connectors,
  };
}

export { PORT };
