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
