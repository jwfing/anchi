import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { download, installArchive, readHostTools, readPin, type Pin } from './host-tools.ts';

/**
 * Signing in to ChatGPT for Codex without a terminal. The daemon runs the pinned Codex CLI as
 * `codex app-server` (its JSON-RPC interface on stdio) with a CODEX_HOME of its own,
 * <Anchi home>/codex, and asks it for a device-code login: the user opens the returned page in
 * any browser and enters the code. Codex writes the login to that home's auth.json, where the
 * refresh token stays on this computer; the daemon imports only the access token into the vault,
 * as it does for the user's own ~/.codex, and asks Codex to refresh it before it expires.
 */

/** The official archives are about 100 MB; anything far larger is not one. */
export const MAX_CODEX_ARCHIVE = 400 * 1024 * 1024;
/** How `done` ends for a sign-in cancelled or replaced by a new one; nobody is told. */
export const SIGN_IN_CANCELLED = 'CODEX_SIGN_IN_CANCELLED';
/** Codex's device codes expire after 15 minutes. */
export const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
/** Refresh when the access token has less than this left (they last about ten days). */
export const REFRESH_BEFORE_MS = 3 * 24 * 3600_000;

const VERIFICATION_URL = /^https:\/\/auth\.openai\.com\/[A-Za-z0-9/._-]{1,100}$/;
const USER_CODE = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;

export function hostCodexPin(
  env: Record<string, string> = readHostTools(),
  platform: string = process.platform,
  arch: string = process.arch,
): Pin | undefined {
  return readPin(
    env,
    'ANCHI_HOST_CODEX',
    platform,
    arch,
    (version, target) =>
      `https://github.com/openai/codex/releases/download/rust-v${version}/codex-${target.codex}.tar.gz`,
  );
}

/** The version `codex --version` prints (`codex-cli 0.160.1`), or null. */
function codexVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], { timeout: 10_000 }).toString();
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The pinned Codex binary under <home>/tools/codex/<version>, downloaded when missing. */
export async function ensureHostCodex(
  home: string,
  onLine: (line: string) => void,
  opts: {
    pin?: Pin;
    fetch?: (url: string) => Promise<Buffer>;
    version?: (binary: string) => string | null;
  } = {},
): Promise<string> {
  const pin = opts.pin ?? hostCodexPin();
  if (!pin) throw new Error('CODEX_UNAVAILABLE: Anchi has no Codex CLI for this computer');
  const version = opts.version ?? codexVersion;
  const parent = join(home, 'tools', 'codex');
  const binary = (dir: string) => join(dir, 'codex');
  const installed = join(parent, pin.version);
  if (existsSync(join(installed, '.complete')) && existsSync(binary(installed))) {
    return binary(installed);
  }
  onLine(`Downloading Codex ${pin.version} (${pin.url})`);
  const body = await (opts.fetch ?? ((url) => download(url, MAX_CODEX_ARCHIVE, 'CODEX')))(pin.url);
  if (body.length > MAX_CODEX_ARCHIVE) throw new Error('CODEX_DOWNLOAD_FAILED: archive too large');
  const dir = installArchive(body, pin, parent, 'CODEX', (tree) => {
    // The archive holds one executable named for its target; it is kept as `codex`.
    const names = readdirSync(tree);
    if (names.length !== 1 || !/^codex-[a-z0-9_-]+$/.test(names[0]!)) {
      throw new Error('CODEX_EXTRACT_FAILED: unexpected archive contents');
    }
    renameSync(join(tree, names[0]!), binary(tree));
    const found = version(binary(tree));
    if (found !== pin.version) {
      throw new Error(`CODEX_EXTRACT_FAILED: codex reports ${found ?? 'nothing'}`);
    }
  });
  return binary(dir);
}

type Message = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

/** One `codex app-server` process: requests by id, notifications by method. */
export class AppServer {
  private next = 1;
  private waiting = new Map<number, (m: Message) => void>();
  private listeners = new Map<string, (params: unknown) => void>();
  private closed: Promise<void>;

  constructor(private child: ChildProcess) {
    this.closed = new Promise((resolve) => child.once('close', () => resolve()));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      // A trusted, pinned binary, but its lines are still bounded and checked.
      if (line.length > 1024 * 1024) return;
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        return;
      }
      if (typeof m?.id === 'number' && this.waiting.has(m.id)) {
        this.waiting.get(m.id)!(m);
        this.waiting.delete(m.id);
      } else if (typeof m?.method === 'string') this.listeners.get(m.method)?.(m.params);
    });
    void this.closed.then(() => {
      for (const reply of this.waiting.values()) reply({ error: { message: 'codex exited' } });
      this.waiting.clear();
    });
  }

  call(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`CODEX_SIGN_IN_FAILED: codex did not answer ${method}`));
      }, timeoutMs);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        if (m.error !== undefined) {
          const message = (m.error as { message?: unknown })?.message;
          reject(
            new Error(
              `CODEX_SIGN_IN_FAILED: ${typeof message === 'string' ? message.slice(0, 200) : method}`,
            ),
          );
        } else resolve(m.result);
      });
      this.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ method, params })}\n`);
  }

  on(method: string, listener: (params: unknown) => void): void {
    this.listeners.set(method, listener);
  }

  /** Initializes the connection, as every client must before other requests. */
  async start(): Promise<this> {
    await this.call('initialize', { clientInfo: { name: 'anchi', version: '1' } });
    this.notify('initialized', {});
    return this;
  }

  close(): Promise<void> {
    this.child.kill();
    return this.closed;
  }
}

export interface DeviceCode {
  verificationUrl: string;
  userCode: string;
}

export class CodexSignIn {
  private pending?: { server: AppServer; loginId: string; finish: (error?: Error) => void };

  constructor(
    private opts: {
      /** The Anchi home: the login goes to <home>/codex, the binary to <home>/tools/codex. */
      home: string;
      log: (line: string) => void;
      /** The Codex binary; downloads the pinned one by default (tests give a fake). */
      binary?: () => Promise<string>;
      timeoutMs?: number;
    },
  ) {}

  get codexHome(): string {
    return join(this.opts.home, 'codex');
  }

  get authFile(): string {
    return join(this.codexHome, 'auth.json');
  }

  private async open(): Promise<AppServer> {
    const binary = await (
      this.opts.binary ?? (() => ensureHostCodex(this.opts.home, this.opts.log))
    )();
    mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
    const child = spawn(binary, ['app-server'], {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.on('error', () => {});
    return new AppServer(child).start();
  }

  /**
   * Starts a device-code login, replacing one still pending. Resolves with the page and code to
   * show; `done` settles when Codex reports the login finished, failed or timed out.
   */
  async start(): Promise<DeviceCode & { done: Promise<void> }> {
    await this.cancel();
    const server = await this.open();
    let finish!: (error?: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
    });
    server.on('account/login/completed', (params) => {
      const p = params as { loginId?: unknown; success?: unknown; error?: unknown };
      if (p?.loginId !== this.pending?.loginId) return;
      finish(
        p.success === false
          ? new Error(
              `CODEX_SIGN_IN_FAILED: ${typeof p.error === 'string' ? p.error.slice(0, 200) : 'the sign-in was not completed'}`,
            )
          : undefined,
      );
    });
    let result: {
      type?: unknown;
      loginId?: unknown;
      verificationUrl?: unknown;
      userCode?: unknown;
    };
    try {
      result = (await server.call('account/login/start', {
        type: 'chatgptDeviceCode',
      })) as typeof result;
    } catch (err) {
      await server.close();
      throw err;
    }
    const { loginId, verificationUrl, userCode } = result ?? {};
    if (
      result?.type !== 'chatgptDeviceCode' ||
      typeof loginId !== 'string' ||
      loginId.length > 200 ||
      typeof verificationUrl !== 'string' ||
      !VERIFICATION_URL.test(verificationUrl) ||
      typeof userCode !== 'string' ||
      !USER_CODE.test(userCode)
    ) {
      await server.close();
      throw new Error('CODEX_SIGN_IN_FAILED: codex returned an unexpected device code');
    }
    this.pending = { server, loginId, finish };
    const timer = setTimeout(
      () => finish(new Error('CODEX_SIGN_IN_FAILED: the code expired; start again')),
      this.opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    );
    const settled = done.finally(async () => {
      clearTimeout(timer);
      if (this.pending?.server === server) this.pending = undefined;
      await server.close();
    });
    // The caller may not wait for `done`; a failure is still reported through it.
    settled.catch(() => {});
    return { verificationUrl, userCode, done: settled };
  }

  /**
   * Ends a pending sign-in: Codex forgets its device code, and its `done` rejects with
   * SIGN_IN_CANCELLED at once, so a replaced sign-in never reports a late failure.
   */
  async cancel(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    await pending.server
      .call('account/login/cancel', { loginId: pending.loginId }, 5000)
      .catch(() => undefined);
    pending.finish(new Error(`${SIGN_IN_CANCELLED}: the sign-in was cancelled`));
    await pending.server.close();
  }

  /** Whether the user signed in here (not with their own Codex CLI). */
  signedIn(): boolean {
    return existsSync(this.authFile);
  }

  /**
   * Asks Codex to refresh the login when the access token has less than REFRESH_BEFORE_MS left
   * (or cannot be read); resolves true when it asked. The refresh token never leaves Codex.
   */
  async refreshIfDue(expiry: number | null, now = Date.now()): Promise<boolean> {
    if (!this.signedIn() || this.pending) return false;
    if (expiry !== null && expiry - now > REFRESH_BEFORE_MS) return false;
    const server = await this.open();
    try {
      await server.call('account/read', { refreshToken: true });
      this.opts.log('codex sign-in refreshed');
      return true;
    } finally {
      await server.close();
    }
  }
}
