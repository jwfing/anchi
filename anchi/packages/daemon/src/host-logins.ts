import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { HostLoginStatus } from '@anchi/protocol';

const LIMIT = 64 * 1024;
export const HOST_CODEX_LOGIN = join(
  process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  'auth.json',
);
const CLAUDE_DIR = (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC');

export interface CodexLogin {
  accessToken: string;
  accountId: string;
}
export interface ClaudeLogin {
  token: string;
  expiresAt: number;
}

/** Expiry is metadata only; the upstream provider verifies the token. */
export function jwtExpiry(token: string): number | null {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function readFile(file: string): string {
  let fd: number | undefined;
  try {
    if (!isAbsolute(file)) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > LIMIT) throw new Error();
    const buffer = Buffer.alloc(LIMIT + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > LIMIT) throw new Error();
    return buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    throw new Error(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'HOST_LOGIN_MISSING'
        : 'HOST_LOGIN_UNAVAILABLE',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function expiry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error();
  if (value <= Date.now() + 120_000) throw new Error('HOST_LOGIN_EXPIRED');
  return value;
}

export function readHostCodexLogin(file = HOST_CODEX_LOGIN): CodexLogin {
  const raw = readFile(file);
  try {
    const { tokens } = JSON.parse(raw);
    const accessToken = tokens?.access_token;
    const accountId = tokens?.account_id;
    if (
      typeof accessToken !== 'string' ||
      !/^[A-Za-z0-9_.-]{100,16000}$/.test(accessToken) ||
      typeof accountId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    )
      throw new Error();
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString());
    if (claims['https://api.openai.com/auth']?.chatgpt_account_id !== accountId) throw new Error();
    expiry(jwtExpiry(accessToken));
    return { accessToken, accountId };
  } catch (error) {
    throw new Error(
      (error as Error).message === 'HOST_LOGIN_EXPIRED'
        ? 'HOST_LOGIN_EXPIRED'
        : 'HOST_LOGIN_UNAVAILABLE',
    );
  }
}

function readClaude(raw: string): ClaudeLogin {
  try {
    if (Buffer.byteLength(raw) > LIMIT) throw new Error();
    const login = JSON.parse(raw)?.claudeAiOauth;
    if (
      typeof login?.accessToken !== 'string' ||
      !/^sk-ant-oat01-[A-Za-z0-9_-]{28,487}$/.test(login.accessToken) ||
      login.accessToken.includes('anchi-placeholder')
    )
      throw new Error();
    return { token: login.accessToken, expiresAt: expiry(login.expiresAt) };
  } catch (error) {
    throw new Error(
      (error as Error).message === 'HOST_LOGIN_EXPIRED'
        ? 'HOST_LOGIN_EXPIRED'
        : 'HOST_LOGIN_UNAVAILABLE',
    );
  }
}

/** Same directory-specific service name as Claude Code; never search unrelated entries. */
export function claudeKeychainService(configDir: string | undefined): string {
  const suffix = configDir
    ? `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`
    : '';
  return `Claude Code-credentials${suffix}`;
}

function keychainRead(service: string): Promise<string | null> {
  let account = process.env.USER;
  try {
    account ||= userInfo().username;
  } catch {
    /* Same fallback as Claude Code. */
  }
  if (!account || !/^[a-zA-Z0-9._-]+$/.test(account)) account = 'claude-code-user';
  return new Promise((resolve) => {
    // Do not use hostOutput: its error includes stderr, which might contain credential data.
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-a', account, '-w', '-s', service],
      { encoding: 'utf8', timeout: 5000, maxBuffer: LIMIT },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export class HostLogins {
  readonly codexFile: string;
  readonly claudeFile: string;
  status: { codex: HostLoginStatus; claude: HostLoginStatus } = {
    codex: { installed: false, state: 'missing' },
    claude: { installed: false, state: 'missing' },
  };
  constructor(
    private options: {
      codexFile?: string;
      claudeDir?: string;
      path?: string;
      platform?: string;
      keychainService?: string;
      keychainRead?: (service: string) => Promise<string | null>;
    } = {},
  ) {
    this.codexFile = options.codexFile ?? HOST_CODEX_LOGIN;
    this.claudeFile = join(options.claudeDir ?? CLAUDE_DIR, '.credentials.json');
  }

  async read(
    enabled = { codex: true, claude: true },
  ): Promise<{ codex: CodexLogin | null; claude: ClaudeLogin | null }> {
    const installed = (name: string) =>
      (this.options.path ?? process.env.PATH ?? '').split(':').some((dir) => {
        try {
          if (!isAbsolute(dir)) return false;
          const file = join(dir, name);
          accessSync(file, constants.X_OK);
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
    const detect = async <T>(
      name: 'codex' | 'claude',
      read: () => T | Promise<T>,
    ): Promise<T | null> => {
      this.status[name] = {
        installed: installed(name),
        state: enabled[name] ? 'missing' : 'disabled',
      };
      if (!enabled[name]) return null;
      try {
        const login = await read();
        this.status[name].state = 'ready';
        return login;
      } catch (error) {
        this.status[name].state =
          (error as Error).message === 'HOST_LOGIN_MISSING'
            ? 'missing'
            : (error as Error).message === 'HOST_LOGIN_EXPIRED'
              ? 'expired'
              : 'unavailable';
        return null;
      }
    };
    const codex = await detect('codex', () => readHostCodexLogin(this.codexFile));
    const claude = await detect('claude', async () => {
      if ((this.options.platform ?? process.platform) === 'darwin') {
        const service =
          this.options.keychainService ??
          claudeKeychainService(
            process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ??
              this.options.claudeDir ??
              process.env.CLAUDE_CONFIG_DIR,
          );
        const raw = await (this.options.keychainRead ?? keychainRead)(service);
        if (raw !== null) return readClaude(raw);
      }
      return readClaude(readFile(this.claudeFile));
    });
    return { codex, claude };
  }
}
