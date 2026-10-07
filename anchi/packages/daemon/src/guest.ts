import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { ConnectorId, ConnectorSecret } from '@anchi/protocol';

/**
 * The daemon's only path into the VM: fixed guest-root commands over `limactl shell ... sudo`.
 * Arguments are validated before they get here; secrets go on stdin, never in arguments.
 */

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GuestTransport {
  /** Runs a guest-root command to completion. */
  exec(args: string[], stdin?: string, timeoutMs?: number): Promise<ExecResult>;
  /** Starts a long-running guest-root command whose stdio the caller owns. */
  spawn(args: string[]): ChildProcessWithoutNullStreams;
}

export class LimaTransport implements GuestTransport {
  constructor(
    readonly vm = process.env.ANCHI_VM ?? 'secure-vm',
    private limactl = process.env.ANCHI_LIMACTL ?? 'limactl',
  ) {
    if (!/^secure-vm(-[a-z0-9-]+)?$/.test(vm)) throw new Error(`invalid VM name ${vm}`);
  }

  private argv(args: string[]): string[] {
    return ['shell', this.vm, '--', 'sudo', '-n', ...args];
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.limactl, this.argv(args), { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  exec(args: string[], stdin = '', timeoutMs = 120_000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(args);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const collect = (into: Buffer[]) => (b: Buffer) => {
        size += b.length;
        if (size > MAX_OUTPUT) child.kill('SIGKILL');
        else into.push(b);
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(err));
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
      child.stdin.end(stdin);
    });
  }

  async vmStatus(): Promise<'missing' | 'stopped' | 'running' | 'unknown'> {
    return new Promise((resolve) => {
      const child = spawn(this.limactl, ['list', '--format', '{{.Name}} {{.Status}}'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.on('error', () => resolve('unknown'));
      child.on('close', () => {
        const line = out.split('\n').find((l) => l.split(' ')[0] === this.vm);
        if (!line) return resolve('missing');
        resolve(line.includes('Running') ? 'running' : 'stopped');
      });
    });
  }
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
    return this.transport.spawn([
      'anchi-cell',
      'start',
      c.task,
      c.agent,
      c.image,
      c.hash,
      connectors,
      c.sandbox,
    ]);
  }

  async stopCell(task: string): Promise<void> {
    parse(await this.transport.exec(['anchi-cell', 'stop', check(task, 'task')]));
  }

  async listCells(): Promise<{ task: string; agent: string; active: boolean }[]> {
    return parse(await this.transport.exec(['anchi-cell', 'list'])).cells as {
      task: string;
      agent: string;
      active: boolean;
    }[];
  }

  async reap(keep: string[] = []): Promise<string[]> {
    const out = parse(
      await this.transport.exec(['anchi-cell', 'reap', ...keep.map((t) => check(t, 'task'))]),
    );
    return out.reaped as string[];
  }

  async scan(task: string): Promise<{ clean: boolean; findings: unknown[]; files: number }> {
    return parse(
      await this.transport.exec(['anchi-cell', 'scan', check(task, 'task')], '', 600_000),
    ) as { clean: boolean; findings: unknown[]; files: number };
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

  async importCodex(accessToken: string, accountId: string): Promise<{ expires_at: number }> {
    return parse(
      await this.transport.exec(
        ['/usr/bin/python3', `${SERVICES}/codex_admin.py`, 'import-token'],
        JSON.stringify({ access_token: accessToken, account_id: accountId }),
      ),
    ) as { expires_at: number };
  }

  async vaultStatus(): Promise<{ unlocked: boolean }> {
    return parse(
      await this.transport.exec(['/usr/bin/python3', `${SERVICES}/vault_admin.py`, 'status']),
    ) as { unlocked: boolean };
  }
}
