import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const MARK = '__ANCHI_PATH__';

/** The PATH between the markers a login shell printed; its startup files may print more. */
export function parseShellPath(output: string): string | undefined {
  const match = new RegExp(`${MARK}(.*)${MARK}`).exec(output);
  return match?.[1] || undefined;
}

/**
 * Directories of `current`, then of `login`, then where the installer puts `anchi` (see
 * landing/dist/install.sh), each once and only absolute ones.
 */
export function mergePath(current: string, login: string | undefined, home: string): string {
  const extra = [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const dirs = [...current.split(delimiter), ...(login?.split(delimiter) ?? []), ...extra];
  return [...new Set(dirs.filter((d) => isAbsolute(d)))].join(delimiter);
}

/**
 * An app opened from the Finder, the Dock or a desktop menu gets the system's minimal PATH, which
 * has neither the installer's `anchi` nor `instabox` or other tools a remote server is reached
 * with. Take the login shell's PATH, as a terminal has it; give up after a few seconds.
 */
export function loginShellPath(
  shell = process.env.SHELL || '/bin/sh',
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 },
      (_err, stdout) => resolve(parseShellPath(stdout ?? '')),
    );
  });
}

/** Sets PATH for the packaged app; a run from the checkout already has the terminal's. */
export async function adoptLoginPath(): Promise<void> {
  process.env.PATH = mergePath(process.env.PATH ?? '', await loginShellPath(), homedir());
}
