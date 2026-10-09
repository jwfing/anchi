import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HomeLayout } from '@anchi/core';
import { DaemonClient } from './rpc.ts';

export const LAUNCHD_LABEL = 'dev.anchi.daemon';

/** node + args that start the daemon from source (tsx loader). */
export function daemonCommand(): string[] {
  if (import.meta.url.endsWith('.mjs')) {
    return [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs')];
  }
  const tsx = createRequire(import.meta.url).resolve('tsx');
  const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
  return [process.execPath, '--import', tsx, main];
}

export async function tryConnect(layout: HomeLayout): Promise<DaemonClient | undefined> {
  try {
    return await DaemonClient.connect(layout.socketFile);
  } catch {
    return undefined;
  }
}

/** Connects to the daemon, starting it in the background first if needed. */
export async function connectOrStart(
  layout: HomeLayout,
  timeoutMs = 15_000,
): Promise<DaemonClient> {
  const existing = await tryConnect(layout);
  if (existing) return existing;
  mkdirSync(dirname(layout.logFile), { recursive: true, mode: 0o700 });
  const out = openSync(layout.logFile, 'a', 0o600);
  const [cmd, ...args] = daemonCommand();
  const child = spawn(cmd!, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ANCHI_HOME: layout.root },
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const client = await tryConnect(layout);
    if (client) return client;
  }
  throw new Error(`daemon did not start within ${timeoutMs / 1000}s; see ${layout.logFile}`);
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist(layout: HomeLayout, path = process.env.PATH ?? ''): string {
  const args = daemonCommand()
    .map((a) => `    <string>${xml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANCHI_HOME</key>
    <string>${xml(layout.root)}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(layout.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(layout.logFile)}</string>
</dict>
</plist>
`;
}

/** systemd quoting: each word double-quoted, with `%` (specifiers), `\\` and `"` escaped; in
 * ExecStart `$` is doubled as well (variable expansion). */
const unitWord = (s: string) =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export const SYSTEMD_UNIT = 'anchi-daemon.service';

function unitPath(): string {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(config, 'systemd', 'user', SYSTEMD_UNIT);
}

/** A systemd user unit equivalent to the launchd agent: started at login, restarted on failure. */
export function systemdUnit(layout: HomeLayout, path = process.env.PATH ?? ''): string {
  for (const value of [layout.root, layout.logFile, path, ...daemonCommand()]) {
    if (/[\n\r]/.test(value)) throw new Error('paths with line breaks cannot go into a unit file');
  }
  return `[Unit]
Description=Anchi daemon

[Service]
ExecStart=${daemonCommand()
    .map((a) => unitWord(a).replace(/\$/g, '$$$$'))
    .join(' ')}
Environment=${unitWord(`ANCHI_HOME=${layout.root}`)} ${unitWord(`PATH=${path}`)}
Restart=on-failure
StandardOutput=append:${layout.logFile.replace(/%/g, '%%')}
StandardError=append:${layout.logFile.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`;
}

/** Runs the daemon at login: launchd on macOS, a systemd user unit on Linux. */
export function installAutostart(layout: HomeLayout): string {
  if (process.platform === 'darwin') return installLaunchd(layout);
  if (process.platform !== 'linux') throw new Error('autostart needs macOS or Linux');
  const file = unitPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(layout.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(file, systemdUnit(layout));
  for (const args of [['daemon-reload'], ['enable', '--now', SYSTEMD_UNIT]]) {
    const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(
        `systemctl --user ${args.join(' ')} failed: ${(res.stderr ?? res.error?.message ?? '').trim()}`,
      );
    }
  }
  return file;
}

export function uninstallAutostart(): string | undefined {
  if (process.platform === 'darwin') return uninstallLaunchd();
  const file = unitPath();
  if (!existsSync(file)) return undefined;
  spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  rmSync(file);
  spawnSync('systemctl', ['--user', 'daemon-reload']);
  return file;
}

export function installLaunchd(layout: HomeLayout): string {
  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(layout.logFile), { recursive: true, mode: 0o700 });
  const domain = `gui/${process.getuid?.() ?? 501}`;
  if (existsSync(file)) spawnSync('launchctl', ['bootout', domain, file]);
  writeFileSync(file, launchdPlist(layout));
  const res = spawnSync('launchctl', ['bootstrap', domain, file], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`launchctl bootstrap failed: ${res.stderr.trim()}`);
  return file;
}

export function uninstallLaunchd(): string | undefined {
  const file = plistPath();
  if (!existsSync(file)) return undefined;
  spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, file]);
  rmSync(file);
  return file;
}
