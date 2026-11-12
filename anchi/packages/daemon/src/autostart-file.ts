import { homedir } from 'node:os';
import { join } from 'node:path';

// Where the login item of the daemon lives. Kept apart from launch.ts, which finds the daemon's
// own entry point through import.meta: the desktop app's main process is bundled as CommonJS and
// only needs these paths.

export const LAUNCHD_LABEL = 'dev.anchi.daemon';
export const SYSTEMD_UNIT = 'anchi-daemon.service';

export function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function unitPath(): string {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(config, 'systemd', 'user', SYSTEMD_UNIT);
}

/** The file that starts the daemon at login, whether or not it exists. */
export function autostartFile(): string {
  return process.platform === 'darwin' ? plistPath() : unitPath();
}
