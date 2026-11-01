import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { download, installArchive, readHostTools, readPin, type Pin } from './host-tools.ts';

/**
 * Signing in to Claude without a terminal. The daemon runs the pinned Claude Code CLI as
 * `claude setup-token`, which creates a long-lived (one-year) subscription token after a browser
 * sign-in. It prints the token only to a terminal, so it runs in a pseudo-terminal (`script`);
 * the token is read from that output in memory, checked, and handed to the vault, never logged.
 *
 * Two pages can finish the sign-in. The one Claude Code opens with $BROWSER returns to a port on
 * `localhost`, so it completes by itself when the browser runs on the daemon's computer. The one
 * it prints returns to a Claude page that shows a code for the user to paste back, which is how a
 * daemon on a remote server signs in: the code goes to the CLI's stdin with `submitCode`.
 */

/** The npm package is about 100 MB; anything far larger is not one. */
export const MAX_CLAUDE_ARCHIVE = 400 * 1024 * 1024;
export const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
/** How long the CLI may take to offer its pages. */
const PAGES_TIMEOUT_MS = 60_000;
/** What `done` rejects with for a sign-in cancelled or replaced by a new one; nobody is told. */
export const SIGN_IN_CANCELLED = 'CLAUDE_SIGN_IN_CANCELLED';

const AUTHORIZE =
  /^https:\/\/(claude\.com|claude\.ai)\/[A-Za-z0-9/._-]*oauth\/authorize\?[A-Za-z0-9%=&._~:/+-]{1,2000}$/;
const TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,480}$/;
/** What Claude's code page shows: letters, digits and a few separators, `#` among them. */
export const PASTED_CODE = /^[A-Za-z0-9_#.~-]{8,500}$/;
const OUTPUT_LIMIT = 256 * 1024;

export function hostClaudePin(
  env: Record<string, string> = readHostTools(),
  platform: string = process.platform,
  arch: string = process.arch,
): Pin | undefined {
  return readPin(
    env,
    'ANCHI_HOST_CLAUDE',
    platform,
    arch,
    (version, target) =>
      `https://registry.npmjs.org/@anthropic-ai/claude-code-${target.claude}/-/claude-code-${target.claude}-${version}.tgz`,
  );
}

function claudeVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ['--version'], { timeout: 10_000 }).toString();
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The pinned Claude Code binary under <home>/tools/claude/<version>, downloaded when missing. */
export async function ensureHostClaude(
  home: string,
  onLine: (line: string) => void,
  opts: {
    pin?: Pin;
    fetch?: (url: string) => Promise<Buffer>;
    version?: (binary: string) => string | null;
  } = {},
): Promise<string> {
  const pin = opts.pin ?? hostClaudePin();
  if (!pin) throw new Error('CLAUDE_UNAVAILABLE: Anchi has no Claude Code for this computer');
  const version = opts.version ?? claudeVersion;
  const parent = join(home, 'tools', 'claude');
  const binary = (dir: string) => join(dir, 'package', 'claude');
  const installed = join(parent, pin.version);
  if (existsSync(join(installed, '.complete')) && existsSync(binary(installed))) {
    return binary(installed);
  }
  onLine(`Downloading Claude Code ${pin.version} (${pin.url})`);
  const body = await (opts.fetch ?? ((url) => download(url, MAX_CLAUDE_ARCHIVE, 'CLAUDE')))(
    pin.url,
  );
  if (body.length > MAX_CLAUDE_ARCHIVE) {
    throw new Error('CLAUDE_DOWNLOAD_FAILED: archive too large');
  }
  const dir = installArchive(body, pin, parent, 'CLAUDE', (tree) => {
    const found = existsSync(binary(tree)) ? version(binary(tree)) : null;
    if (found !== pin.version) {
      throw new Error(`CLAUDE_EXTRACT_FAILED: package/claude reports ${found ?? 'nothing'}`);
    }
  });
  return binary(dir);
}

/** Terminal escapes and carriage returns removed, so the screen reads as text. */
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>78]/g, '')
    .replace(/\r/g, '');
}

/**
 * The token `setup-token` printed, which the terminal may have wrapped over several lines, or
 * undefined. Only a well-formed subscription token is returned. Claude Code draws its line breaks
 * with cursor movements, so once those are removed the token may run into the text around it.
 */
export function tokenFrom(raw: string): string | undefined {
  const text = screenText(raw);
  const m = /valid for 1 year\):([\s\S]*?)Store this token/.exec(text);
  const token = m ? m[1]!.replace(/\s+/g, '') : '';
  return TOKEN.test(token) ? token : undefined;
}

/**
 * The page whose sign-in ends with a code to paste (it returns to a Claude page), from the
 * terminal output as written: escape sequences end a URL, so the hyperlink's target is found
 * whole even where the visible text wraps it.
 */
export function codePageFrom(raw: string): string | undefined {
  for (const m of raw.matchAll(/https:\/\/[A-Za-z0-9./%?=&_:~+-]+/g)) {
    const url = m[0];
    if (!AUTHORIZE.test(url)) continue;
    const redirect = new URL(url).searchParams.get('redirect_uri') ?? '';
    if (/^https:\/\/[a-z.]*claude\.(com|ai)\//.test(redirect)) return url;
  }
  return undefined;
}

/**
 * `script` gives the CLI a pseudo-terminal on macOS and on Linux (util-linux), its screen on
 * stdout. Its stdin must be a pipe it can ask about: Node's are sockets, so `cat` relays them
 * through a process substitution, which leaves `script` this process: its exit is the CLI's.
 */
export function ptyCommand(
  binary: string,
  platform: string = process.platform,
): { command: string; args: string[] } {
  const script =
    platform === 'darwin'
      ? ['/usr/bin/script', '-q', '/dev/null', binary, 'setup-token']
      : // util-linux `script` waits for stdin to close after the command ends; the command's
        // shell ends it instead, a second later so the last output (the token) is relayed.
        [
          'script',
          '-q',
          '-e',
          '-c',
          `'${binary.replace(/'/g, `'\\''`)}' setup-token; sleep 1; kill -TERM $PPID`,
          '/dev/null',
        ];
  return { command: '/bin/bash', args: ['-c', 'exec "$0" "$@" < <(exec cat)', ...script] };
}

export interface ClaudePages {
  /** The page to open: on this computer it finishes by itself; elsewhere it shows a code. */
  url: string;
  /** Whether the user pastes the code the page shows (`submitCode`). */
  codeRequired: boolean;
}

export class ClaudeSignIn {
  private pending?: {
    child: ChildProcess;
    config: string;
    finish: (error?: Error) => void;
  };

  constructor(
    private opts: {
      /** The Anchi home: the binary goes to <home>/tools/claude. */
      home: string;
      log: (line: string) => void;
      /** Where the browser runs: here (`localhost` returns) or on another computer (a code). */
      browserHere: boolean;
      /** Receives the token; the vault import. */
      store: (token: string) => Promise<void>;
      /** The Claude Code binary; downloads the pinned one by default (tests give a fake). */
      binary?: () => Promise<string>;
      timeoutMs?: number;
    },
  ) {}

  /**
   * Starts `claude setup-token`, replacing a sign-in still pending. Resolves with the page to
   * open; `done` settles once the token is stored, or the CLI ends without one, or time runs out.
   */
  async start(): Promise<ClaudePages & { done: Promise<void> }> {
    await this.cancel();
    const binary = await (
      this.opts.binary ?? (() => ensureHostClaude(this.opts.home, this.opts.log))
    )();
    // A fresh, private configuration directory: nothing of the user's own Claude Code is read or
    // written, and the opened page is recorded instead of a browser starting on this computer.
    mkdirSync(join(this.opts.home, 'run'), { recursive: true, mode: 0o700 });
    const config = mkdtempSync(join(this.opts.home, 'run', 'claude-sign-in-'));
    const opened = join(config, 'opened-url');
    const browser = join(config, 'browser');
    writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" > '${opened}'\n`);
    chmodSync(browser, 0o700);
    const { command, args } = ptyCommand(binary);
    // Its own process group: ending the sign-in ends `cat`, `script` and the CLI together.
    const child = spawn(command, args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, BROWSER: browser, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    });
    const end = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        // Already gone.
      }
    };
    let output = '';
    let finish!: (error?: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
    });
    let stored = false;
    child.stdout!.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
      const token = stored ? undefined : tokenFrom(output);
      if (!token) return;
      stored = true;
      output = '';
      this.opts.store(token).then(
        () => finish(),
        (err: Error) => finish(new Error(`CLAUDE_SIGN_IN_FAILED: ${err.message.slice(0, 200)}`)),
      );
    });
    child.on('error', () => finish(new Error('CLAUDE_SIGN_IN_FAILED: cannot start Claude Code')));
    child.on('close', () => {
      if (!stored) finish(new Error('CLAUDE_SIGN_IN_FAILED: the sign-in did not finish'));
    });
    this.pending = { child, config, finish };
    const timer = setTimeout(
      () => finish(new Error('CLAUDE_SIGN_IN_FAILED: the sign-in timed out; start again')),
      this.opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    );
    const settled = done.finally(() => {
      clearTimeout(timer);
      output = '';
      if (this.pending?.child === child) this.pending = undefined;
      end();
      rmSync(config, { recursive: true, force: true });
    });
    settled.catch(() => {});

    // Wait for the page this sign-in will use.
    const deadline = Date.now() + PAGES_TIMEOUT_MS;
    let page: ClaudePages | undefined;
    while (!page && Date.now() < deadline && this.pending?.child === child) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.opts.browserHere && existsSync(opened)) {
        const url = readFileSync(opened, 'utf8').trim();
        if (AUTHORIZE.test(url)) page = { url, codeRequired: false };
      } else if (!this.opts.browserHere) {
        // From the raw output: the whole URL is in the OSC 8 link; the text shown wraps it.
        const url = codePageFrom(output);
        if (url) page = { url, codeRequired: true };
      }
    }
    if (!page) {
      finish(new Error('CLAUDE_SIGN_IN_FAILED: Claude Code offered no sign-in page'));
      await settled.catch(() => {});
      throw new Error('CLAUDE_SIGN_IN_FAILED: Claude Code offered no sign-in page');
    }
    return { ...page, done: settled };
  }

  /** Types the code Claude's page showed into the pending sign-in. */
  submitCode(code: string): void {
    if (!this.pending) throw new Error('CLAUDE_SIGN_IN_FAILED: no sign-in is waiting for a code');
    if (!PASTED_CODE.test(code))
      throw new Error('CLAUDE_SIGN_IN_FAILED: that is not a sign-in code');
    this.pending.child.stdin!.write(`${code}\r`);
  }

  /** Ends a pending sign-in at once; its `done` rejects with SIGN_IN_CANCELLED. */
  async cancel(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.finish(new Error(`${SIGN_IN_CANCELLED}: the sign-in was cancelled`));
  }
}
