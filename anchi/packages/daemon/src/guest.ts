import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import type { ConnectorId, ConnectorSecret, RuntimeId } from '@anchi/protocol';
import { VM_NAME } from './host.ts';

/** What the proxy kept of a runtime's limits (snake case, seconds). */
interface GuestQuota {
  ts: number;
  status: number;
  headers?: Record<string, string>;
  plan?: string | null;
  limited?: boolean;
  windows?: {
    name: string;
    used_percent: number | null;
    window_minutes: number | null;
    reset_at: number | null;
  }[];
}

/**
 * The daemon's only path into the guest: fixed guest-root commands over `limactl shell ... sudo`,
 * or plain `sudo` when the daemon runs inside the guest.
 * Arguments are validated before they get here; secrets go on stdin, never in arguments.
 */

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `anchi-cell scan`: findings by label, and whether a limit stopped the scan early. */
export interface ScanResult {
  clean: boolean;
  findings: unknown[];
  files: number;
  /** A limit (`files`, `bytes` or `time`) stopped the scan before the end. */
  partial?: boolean;
  stopped_at?: string;
}

export interface GuestTransport {
  /** Runs a guest-root command to completion. */
  exec(args: string[], stdin?: string, timeoutMs?: number): Promise<ExecResult>;
  /** Starts a long-running guest-root command whose stdio the caller owns. */
  spawn(args: string[]): ChildProcessWithoutNullStreams;
}

/** Where the guest is: a Lima VM on this computer, or this machine itself. */
export interface VmTransport extends GuestTransport {
  /** `lima`: a VM this computer runs; `local`: the daemon runs inside the guest. */
  readonly placement: 'lima' | 'local';
  vmStatus(): Promise<'missing' | 'stopped' | 'running' | 'unknown'>;
  /** The guest's CPUs and memory, for the Runtimes screen. */
  vmSize(): Promise<{ cpus: number; memoryGiB: number } | undefined>;
}

/** Runs `child` to completion with `stdin`, keeping at most MAX_OUTPUT bytes of its output. */
function collect(
  child: ChildProcessWithoutNullStreams,
  stdin: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const into = (chunks: Buffer[]) => (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT) child.kill('SIGKILL');
      else chunks.push(b);
    };
    child.stdout.on('data', into(out));
    child.stderr.on('data', into(err));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    // A child that exits before draining stdin (VM stopped, guest refuses early, SIGKILL
    // above) raises EPIPE here; the failure already surfaces through `close`.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

export class LimaTransport implements VmTransport {
  readonly placement = 'lima';

  constructor(
    readonly vm = process.env.ANCHI_VM ?? VM_NAME,
    private limactl = process.env.ANCHI_LIMACTL ?? 'limactl',
  ) {
    if (!/^anchi-vm(-[a-z0-9-]+)?$/.test(vm)) throw new Error(`invalid VM name ${vm}`);
  }

  private argv(args: string[]): string[] {
    return ['shell', this.vm, '--', 'sudo', '-n', ...args];
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.limactl, this.argv(args), { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  exec(args: string[], stdin = '', timeoutMs = 120_000): Promise<ExecResult> {
    return collect(this.spawn(args), stdin, timeoutMs);
  }

  /** The VM's line of `limactl list` in `format`, or undefined when there is none. */
  private list(format: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn(this.limactl, ['list', '--format', format], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.on('error', () => resolve(undefined));
      child.on('close', () => resolve(out.split('\n').find((l) => l.split(' ')[0] === this.vm)));
    });
  }

  async vmStatus(): Promise<'missing' | 'stopped' | 'running' | 'unknown'> {
    const line = await this.list('{{.Name}} {{.Status}}');
    if (line === undefined) return 'missing';
    return line.includes('Running') ? 'running' : 'stopped';
  }

  /** The VM's CPUs and memory as Lima reports them (memory in bytes), for the Runtimes screen. */
  async vmSize(): Promise<{ cpus: number; memoryGiB: number } | undefined> {
    const line = await this.list('{{.Name}} {{.CPUs}} {{.Memory}}');
    const [, cpus, bytes] = (line ?? '').split(' ');
    if (!/^\d+$/.test(cpus ?? '') || !/^\d+$/.test(bytes ?? '')) return undefined;
    return { cpus: Number(cpus), memoryGiB: Math.round(Number(bytes) / 2 ** 30) };
  }
}

/**
 * The daemon running inside the guest itself (a remote server such as an instabox VM): the same
 * fixed guest-root commands through `sudo -n`, with no VM to start or size.
 */
export class InGuestTransport implements VmTransport {
  readonly placement = 'local';

  constructor(private sudo = process.env.ANCHI_SUDO ?? 'sudo') {}

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.sudo, ['-n', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  exec(args: string[], stdin = '', timeoutMs = 120_000): Promise<ExecResult> {
    return collect(this.spawn(args), stdin, timeoutMs);
  }

  async vmStatus(): Promise<'running'> {
    return 'running';
  }

  async vmSize(): Promise<{ cpus: number; memoryGiB: number }> {
    return { cpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30) };
  }
}

/** The guest this daemon drives: `ANCHI_GUEST=local` when it runs inside the guest. */
export function vmTransport(placement = process.env.ANCHI_GUEST ?? 'lima'): VmTransport {
  if (placement === 'local') return new InGuestTransport();
  if (placement === 'lima') return new LimaTransport();
  throw new Error(`ANCHI_GUEST must be lima or local, not ${placement}`);
}

export class GuestError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GuestError';
  }
}

function parse(result: ExecResult): Record<string, unknown> {
  const last = result.stdout.trim().split('\n').at(-1) ?? '';
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    throw new GuestError('GUEST_UNAVAILABLE', result.stderr.trim().slice(-300) || undefined);
  }
  if (typeof value !== 'object' || value === null) throw new GuestError('GUEST_BAD_OUTPUT');
  const obj = value as Record<string, unknown>;
  if (result.code !== 0 || 'error' in obj) {
    throw new GuestError(
      String(obj.error ?? 'GUEST_FAILED'),
      typeof obj.detail === 'string'
        ? obj.detail
        : typeof obj.tail === 'string'
          ? obj.tail
          : undefined,
    );
  }
  return obj;
}

function check(value: string, what: string): string {
  if (!NAME.test(value)) throw new Error(`invalid ${what} "${value}"`);
  return value;
}

const SERVICES = '/opt/secure-vm/services';

export interface CellStart {
  task: string;
  agent: string;
  image: string;
  hash: string;
  connectors: string[];
  sandbox: 'cell' | 'codex-workspace-write';
  runtime: RuntimeId;
  /** Connectors whose writes wait for approval. */
  ask: string[];
  /** X and Reddit, when the agent's approvals make its posts automatic. */
  auto?: string[];
  /** Directories under ~/AnchiWorkspaces bound into the cell. */
  workspaces: { name: string; path: string; mode: 'ro' | 'rw' }[];
  /** Allowed hosts, or undefined for open egress. */
  egress?: string[];
  /** Google account per service (gmail, drive); `default` for the others. */
  accounts?: Record<string, string>;
  /** High-risk entries that do not wait for approval in this cell, by id. */
  highRiskDisabled?: string[];
}

export interface PollItem {
  id: string;
  title: string;
  url: string;
}

export interface ImageMeta {
  image: string;
  hash: string;
  ok: boolean;
  size: number;
  seconds: number;
  log: string;
}

/** Typed fixed commands. */
export class Guest {
  constructor(readonly transport: GuestTransport) {}

  startCell(c: CellStart): ChildProcessWithoutNullStreams {
    check(c.task, 'task');
    check(c.agent, 'agent');
    check(c.image, 'image');
    if (!/^(base|[0-9a-f]{16})$/.test(c.hash)) throw new Error('invalid image hash');
    const connectors = c.connectors.length ? c.connectors.join(',') : '-';
    if (!/^(-|[a-z]+(,[a-z]+)*)$/.test(connectors)) throw new Error('invalid connectors');
    const accounts =
      Object.entries(c.accounts ?? {})
        .filter(([service]) => c.connectors.includes(service))
        .map(([service, account]) => `${service}=${account}`)
        .join(',') || '-';
    if (
      !/^(-|(gmail|drive)=[a-z0-9][a-z0-9_-]{0,31}(,(gmail|drive)=[a-z0-9][a-z0-9_-]{0,31})*)$/.test(
        accounts,
      )
    ) {
      throw new Error('invalid accounts');
    }
    const highRisk = c.highRiskDisabled?.join(',') ?? '';
    if (!/^([a-z0-9-]{1,40}(,[a-z0-9-]{1,40})*)?$/.test(highRisk)) {
      throw new Error('invalid high-risk ids');
    }
    const auto = (c.auto ?? []).filter((x) => c.connectors.includes(x)).join(',');
    if (!/^((x|reddit)(,(x|reddit))?)?$/.test(auto)) throw new Error('invalid auto services');
    return this.transport.spawn([
      'anchi-cell',
      'start',
      c.task,
      c.agent,
      c.image,
      c.hash,
      connectors,
      c.sandbox,
      c.runtime,
      c.ask.filter((x) => c.connectors.includes(x)).join(',') || '-',
      c.workspaces.length ? Buffer.from(JSON.stringify(c.workspaces)).toString('base64url') : '-',
      c.egress ? Buffer.from(JSON.stringify(c.egress)).toString('base64url') : '-',
      accounts,
      // Only when set, so a guest installed before high-risk exceptions per agent still starts;
      // an older guest refuses an agent whose X or Reddit posts are automatic (USAGE).
      ...(highRisk || auto ? [highRisk || '-'] : []),
      ...(auto ? [auto] : []),
    ]);
  }

  async stopCell(task: string): Promise<void> {
    parse(await this.transport.exec(['anchi-cell', 'stop', check(task, 'task')]));
  }

  /** Cells in the VM; an image build under way is listed with `kind: 'build'`. */
  async listCells(): Promise<{ task: string; agent: string; active: boolean; kind?: string }[]> {
    return parse(await this.transport.exec(['anchi-cell', 'list'])).cells as {
      task: string;
      agent: string;
      active: boolean;
      kind?: string;
    }[];
  }

  async reap(keep: string[] = []): Promise<string[]> {
    const out = parse(
      await this.transport.exec(['anchi-cell', 'reap', ...keep.map((t) => check(t, 'task'))]),
    );
    return out.reaped as string[];
  }

  async scan(task: string): Promise<ScanResult> {
    return parse(
      await this.transport.exec(['anchi-cell', 'scan', check(task, 'task')], '', 600_000),
    ) as unknown as ScanResult;
  }

  /**
   * Removes a deleted agent's home, skills bundle and policy rules in the VM. The guest refuses
   * while the agent has a cell, and never crosses a mount (workspaces stay untouched).
   */
  async purgeAgent(agent: string): Promise<{ home: boolean; skills: boolean; policy: string[] }> {
    return parse(
      await this.transport.exec(['anchi-cell', 'purge-agent', check(agent, 'agent')]),
    ) as {
      home: boolean;
      skills: boolean;
      policy: string[];
    };
  }

  /** A task's rows of the egress audit log (the latest 2,000), read by guest root. */
  async audit(
    task: string,
  ): Promise<{ rows: Record<string, unknown>[]; total: number; truncated: boolean }> {
    return parse(
      await this.transport.exec(['anchi-cell', 'audit', check(task, 'task')], '', 60_000),
    ) as {
      rows: Record<string, unknown>[];
      total: number;
      truncated: boolean;
    };
  }

  /**
   * The Anchi version that installed the guest components, or null when the guest predates the
   * command (then it is older than any Anchi that asks).
   */
  async version(): Promise<string | null> {
    try {
      const out = parse(await this.transport.exec(['anchi-cell', 'version']));
      return typeof out.runtime_version === 'string' ? out.runtime_version.slice(0, 40) : null;
    } catch (err) {
      if (err instanceof GuestError) return null;
      throw err;
    }
  }

  /** The latest limits the proxy saw in the runtimes' responses, by injection rule. */
  async quota(): Promise<Record<string, GuestQuota>> {
    return parse(await this.transport.exec(['anchi-cell', 'quota'])) as Record<string, GuestQuota>;
  }

  async imageStatus(image: string, hash: string): Promise<boolean> {
    return Boolean(
      parse(await this.transport.exec(['anchi-image', 'status', check(image, 'image'), hash]))
        .present,
    );
  }

  async buildImage(
    image: string,
    hash: string,
    recipe?: { packages: string[]; run: string[] },
  ): Promise<ImageMeta> {
    return parse(
      await this.transport.exec(
        ['anchi-image', 'build', check(image, 'image'), hash],
        recipe ? JSON.stringify(recipe) : '',
        3_600_000,
      ),
    ) as unknown as ImageMeta;
  }

  async connectorStatus(): Promise<Record<string, { connected: boolean; account: string | null }>> {
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/admin.py`, 'status']),
    ) as Record<string, { connected: boolean; account: string | null }>;
  }

  async setConnector(secret: ConnectorSecret): Promise<void> {
    if (secret.id === 'aws') {
      const value: Record<string, string> = {
        access_key_id: secret.accessKeyId,
        secret_access_key: secret.secretAccessKey,
        region: secret.region,
      };
      if (secret.sessionToken) value.session_token = secret.sessionToken;
      parse(
        await this.transport.exec(
          ['/usr/bin/python3', `${SERVICES}/admin.py`, 'import-aws', 'aws'],
          JSON.stringify(value),
        ),
      );
      return;
    }
    parse(
      await this.transport.exec(
        ['/usr/bin/python3', `${SERVICES}/admin.py`, 'import-token', secret.id],
        JSON.stringify({ token: secret.token }),
      ),
    );
  }

  async setConnectorAccount(id: ConnectorId, label: string): Promise<void> {
    parse(
      await this.transport.exec(
        ['/usr/bin/python3', `${SERVICES}/admin.py`, 'set-account', id],
        JSON.stringify({ account: label }),
      ),
    );
  }

  /** Has the egress proxy call the connector's identity endpoint; returns the account. */
  async verifyConnector(id: ConnectorId): Promise<string> {
    const r = parse(await this.transport.exec(['anchi-cell', 'verify', id])) as { account: string };
    return r.account;
  }

  async removeConnector(id: ConnectorId): Promise<void> {
    parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/admin.py`, 'disconnect', id]),
    );
  }

  async codexStatus(): Promise<{
    configured: boolean;
    account_id: string | null;
    expires_at: number | null;
  }> {
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/codex_admin.py`, 'status']),
    ) as { configured: boolean; account_id: string | null; expires_at: number | null };
  }

  /** Replaces an agent's skill bundle in the VM (files base64-encoded, on stdin). */
  async setSkills(agent: string, files: Record<string, string>): Promise<void> {
    check(agent, 'agent');
    parse(
      await this.transport.exec(
        ['anchi-cell', 'skills', 'set', agent],
        JSON.stringify({ files }),
        60_000,
      ),
    );
  }

  /** Runs a polling trigger's fixed query in the egress service; returns the items found. */
  async poll(kind: string, params: Record<string, unknown>): Promise<PollItem[]> {
    const r = parse(
      await this.transport.exec(['anchi-cell', 'poll'], JSON.stringify({ kind, params }), 60_000),
    ) as { items?: unknown };
    if (!Array.isArray(r.items)) throw new GuestError('GUEST_BAD_OUTPUT');
    return r.items
      .filter((i): i is PollItem => typeof i?.id === 'string')
      .map((i) => ({
        id: i.id.slice(0, 100),
        title: String(i.title ?? '').slice(0, 300),
        url: String(i.url ?? '').slice(0, 500),
      }));
  }

  /** A pending connector-service write, as the policy service recorded it. */
  async policyShow(id: string): Promise<{
    id: string;
    digest: string;
    state: string;
    principal: string;
    expires: number;
    created: number;
    action: { operation?: string; params?: unknown };
  }> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('invalid approval id');
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/policy_admin.py`, 'show', id]),
    ) as never;
  }

  async policyDecide(id: string, allow: boolean, digest: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(digest))
      throw new Error('invalid approval');
    parse(
      await this.transport.exec(
        allow
          ? ['/usr/bin/python3', `${SERVICES}/policy_admin.py`, 'approve', id, '--digest', digest]
          : ['/usr/bin/python3', `${SERVICES}/policy_admin.py`, 'deny', id],
      ),
    );
  }

  /** Whether ~/AnchiWorkspaces is mounted in the VM. */
  async workspacesMounted(): Promise<boolean> {
    const r = await this.transport.exec(['mountpoint', '-q', '/mnt/anchi-host']);
    return r.code === 0;
  }

  async claudeStatus(): Promise<{
    configured: boolean;
    kind: 'oauth' | 'api_key' | null;
    expires_at?: number | null;
  }> {
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/claude_admin.py`, 'status']),
    ) as { configured: boolean; kind: 'oauth' | 'api_key' | null; expires_at?: number | null };
  }

  /** A `claude setup-token` token or an API key, on stdin only. */
  async importClaude(token: string, expiresAt?: number): Promise<void> {
    parse(
      await this.transport.exec(
        ['/usr/bin/python3', `${SERVICES}/claude_admin.py`, 'import-token'],
        JSON.stringify({
          token,
          ...(expiresAt === undefined ? {} : { expires_at: expiresAt / 1000 }),
        }),
      ),
    );
  }

  async hermesStatus(): Promise<{
    configured: boolean;
    base_url: string | null;
    model: string | null;
  }> {
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/hermes_admin.py`, 'status']),
    ) as { configured: boolean; base_url: string | null; model: string | null };
  }

  /** Hermes's OpenAI-compatible endpoint; the API key goes on stdin only. */
  async importHermes(baseUrl: string, apiKey: string, model: string): Promise<void> {
    parse(
      await this.transport.exec(
        ['/usr/bin/python3', `${SERVICES}/hermes_admin.py`, 'import'],
        JSON.stringify({ base_url: baseUrl, api_key: apiKey, model }),
      ),
    );
  }

  async importCodex(accessToken: string, accountId: string): Promise<{ expires_at: number }> {
    return parse(
      await this.transport.exec(
        ['/usr/bin/python3', `${SERVICES}/codex_admin.py`, 'import-token'],
        JSON.stringify({ access_token: accessToken, account_id: accountId }),
      ),
    ) as { expires_at: number };
  }

  /**
   * Whether Anchi's services are on the guest at all. False only when they are certainly absent
   * (a server before its first install); a guest that cannot be asked throws.
   */
  async servicesInstalled(): Promise<boolean> {
    const { code, stderr } = await this.transport.exec([
      'test',
      '-f',
      `${SERVICES}/vault_admin.py`,
    ]);
    if (code === 0 || code === 1) return code === 0;
    throw new GuestError('GUEST_UNAVAILABLE', stderr.trim().slice(-300) || `exit ${code}`);
  }

  async vaultStatus(): Promise<{ unlocked: boolean }> {
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/vault_admin.py`, 'status']),
    ) as { unlocked: boolean };
  }
}
