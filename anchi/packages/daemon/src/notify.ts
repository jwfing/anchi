import { execFile } from 'node:child_process';

/** Escapes a string for an AppleScript string literal. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The command that shows a desktop notification on this platform, or undefined. `message` may
 * be agent-originated; it is flattened and cut, and passed as an argument, never through a shell.
 */
export function notifyCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
): [string, string[]] | undefined {
  // eslint-disable-next-line no-control-regex
  const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ');
  const [t, m] = [flat(title).slice(0, 80), flat(message).slice(0, 240)];
  if (platform === 'darwin') {
    return [
      'osascript',
      ['-e', `display notification ${appleScriptString(m)} with title ${appleScriptString(t)}`],
    ];
  }
  // notify-send (libnotify) is optional; without it the notification is skipped.
  if (platform === 'linux') return ['notify-send', ['--app-name=Anchi', '--', t, m]];
  return undefined;
}

/** Desktop notification (macOS, or Linux with notify-send); failures are ignored. */
export function desktopNotify(title: string, message: string): Promise<void> {
  const command = notifyCommand(process.platform, title, message);
  if (!command) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(command[0], command[1], () => resolve());
  });
}
