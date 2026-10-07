import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServiceConnectorId, ServiceConnectorStatus } from '@anchi/protocol';
import type { Guest } from './guest.ts';

/**
 * Setup of the trusted connector services (Gmail, Drive, Notion, Slack), moved from the
 * desktop app. Credentials go to the VM over stdin; Google tokens are obtained in the VM from
 * an authorization code, so they never exist on the Mac.
 */

export const SERVICE_IDS: ServiceConnectorId[] = ['gmail', 'drive', 'notion', 'slack'];
export const GOOGLE_IDS: ServiceConnectorId[] = ['gmail', 'drive'];
const SERVICES = '/opt/secure-vm/services';
const LOGIN_TIMEOUT_MS = 590_000;

type Exec = Guest['transport']['exec'];

async function json(exec: Exec, args: string[], stdin = ''): Promise<Record<string, unknown>> {
  const r = await exec(['/usr/bin/python3', ...args], stdin);
  let value: Record<string, unknown>;
  // Some admin tools print indented JSON, others one line after other output.
  const out = r.stdout.trim();
  try {
    value = JSON.parse(out) as Record<string, unknown>;
  } catch {
    try {
      value = JSON.parse(out.split('\n').at(-1) ?? '') as Record<string, unknown>;
    } catch {
      throw new Error('the VM did not answer; is it running?');
    }
  }
  if (r.code !== 0 || 'error' in value)
    throw new Error(String(value.error ?? 'SERVICE_ADMIN_FAILED'));
  return value;
}

/** Opens the sign-in page in the default browser; `anchi setup service` also prints the URL. */
export function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!cmd) return;
  // A missing command must not take the daemon down.
  const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export class ServiceSetup {
  private logins = new Map<ServiceConnectorId, Server>();

  constructor(
    private guest: Guest,
    private onLogin: (r: {
      id: ServiceConnectorId;
      ok: boolean;
      error?: string;
    }) => void = () => {},
    private openUrl: (url: string) => void = openInBrowser,
  ) {}

  private get exec(): Exec {
    return (args, stdin, timeout) => this.guest.transport.exec(args, stdin, timeout);
  }

  async status(): Promise<{ services: ServiceConnectorStatus[]; googleClient: boolean }> {
    const all = await json(this.exec, [`${SERVICES}/admin.py`, 'status']);
    const rules = ((await json(this.exec, [`${SERVICES}/policy_admin.py`, 'rules'])).rules ??
      {}) as Record<string, string>;
    const services = SERVICE_IDS.map((id) => {
      const s = (all[id] ?? {}) as Record<string, unknown>;
      return {
        id,
        connected: s.connected === true,
        account: typeof s.account === 'string' ? s.account : null,
        reauthRequired: s.reauth_required === true,
        mode: rules[id] === 'ask' ? ('ask' as const) : ('auto' as const),
      };
    });
    return { services, googleClient: all.client_configured === true };
  }

  /** Notion or Slack token, then the account label from the service itself. */
  async setToken(id: ServiceConnectorId, token: string): Promise<void> {
    if (id !== 'notion' && id !== 'slack') throw new Error(`${id} connects through Google sign-in`);
    await json(this.exec, [`${SERVICES}/admin.py`, 'import-token', id], JSON.stringify({ token }));
    await this.probe(id);
  }

  private async probe(id: ServiceConnectorId) {
    try {
      await json(this.exec, [`${SERVICES}/connector_admin.py`, id, 'probe']);
    } catch {
      // The label is a convenience; the connection itself is stored.
    }
  }

  async disconnect(id: ServiceConnectorId): Promise<void> {
    await json(this.exec, [`${SERVICES}/connector_admin.py`, id, 'disconnect']);
  }

  /** `auto`: standing authorization. `ask`: every write waits for approval in the TUI. */
  async setMode(id: ServiceConnectorId, mode: 'auto' | 'ask'): Promise<void> {
    await json(this.exec, [`${SERVICES}/policy_admin.py`, 'mode', id, mode]);
  }

  /** The Google Cloud "Desktop app" OAuth client JSON, stored in the vault. */
  async setGoogleClient(clientJson: string): Promise<void> {
    if (clientJson.length > 16_384) throw new Error('client JSON too large');
    JSON.parse(clientJson);
    await json(this.exec, [`${SERVICES}/admin.py`, 'import-client', 'gmail'], clientJson);
  }

  /**
   * Starts Google sign-in for Gmail or Drive: a loopback callback on 127.0.0.1, the
   * authorization URL from the VM, and the code back to the VM. Returns the URL to open.
   */
  async googleLogin(id: ServiceConnectorId): Promise<string> {
    if (!GOOGLE_IDS.includes(id)) throw new Error(`${id} does not use Google sign-in`);
    this.logins.get(id)?.close();
    let expected = { host: '', state: '' };
    let finish: (r: { code: string; state: string } | null) => void = () => {};
    const result = new Promise<{ code: string; state: string } | null>((r) => (finish = r));
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const state = url.searchParams.get('state') ?? '';
      const valid =
        url.pathname === '/callback' &&
        req.headers.host === expected.host &&
        state.length === expected.state.length &&
        timingSafeEqual(Buffer.from(state), Buffer.from(expected.state));
      if (!valid) {
        res.writeHead(400).end();
        return;
      }
      const code = url.searchParams.get('code');
      res
        .writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        .end('Authorization received. You can close this tab and return to Anchi.');
      finish(code && !url.searchParams.has('error') ? { code, state } : null);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    this.logins.set(id, server);
    const { port } = server.address() as AddressInfo;
    expected.host = `127.0.0.1:${port}`;
    const flow = await json(
      this.exec,
      [`${SERVICES}/admin.py`, 'begin', id],
      JSON.stringify({ redirect_uri: `http://${expected.host}/callback` }),
    ).catch((err: Error) => {
      server.close();
      throw err;
    });
    expected = { ...expected, state: String(flow.state) };
    const timer = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
    void result.then(async (callback) => {
      clearTimeout(timer);
      server.close();
      this.logins.delete(id);
      if (!callback)
        return this.onLogin({ id, ok: false, error: 'sign-in cancelled or timed out' });
      try {
        await json(this.exec, [`${SERVICES}/admin.py`, 'complete', id], JSON.stringify(callback));
        await this.probe(id);
        this.onLogin({ id, ok: true });
      } catch (err) {
        this.onLogin({ id, ok: false, error: (err as Error).message });
      }
    });
    const url = String(flow.url);
    this.openUrl(url);
    return url;
  }

  stop(): void {
    for (const server of this.logins.values()) server.close();
  }
}
