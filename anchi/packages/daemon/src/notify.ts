import { execFile } from 'node:child_process';

/** Escapes a string for an AppleScript string literal. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** macOS notification. `message` may be agent-originated; it is flattened and cut. */
export function desktopNotify(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  // eslint-disable-next-line no-control-regex
  const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ');
  const script = `display notification ${appleScriptString(flat(message).slice(0, 240))} with title ${appleScriptString(flat(title).slice(0, 80))}`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], () => resolve());
  });
}
