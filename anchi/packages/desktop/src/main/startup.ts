import type { Confirmation } from './bridge.ts';

/**
 * Switches the local daemon's start at login. The window only says on or off; either way is
 * confirmed here, because removing the login item stops a daemon that login started. `run`
 * calls the CLI (`anchi daemon install` or `uninstall`), which knows how the daemon is started.
 * Returns whether the login item exists afterwards.
 */
export async function switchLoginStartup(
  on: unknown,
  deps: {
    platform: string;
    installed(): boolean;
    confirm(question: Confirmation): Promise<boolean>;
    run(args: string[]): Promise<void>;
  },
): Promise<boolean> {
  if (typeof on !== 'boolean') throw new Error('choose on or off');
  if (deps.platform === 'win32') throw new Error('Windows has no local Anchi server');
  const question: Confirmation = on
    ? {
        message: 'Start Anchi’s background service when you log in?',
        detail:
          'Anchi adds a login item for its daemon on this computer (launchd on macOS, a systemd user unit on Linux), so agents and schedules work without opening this app.',
        button: 'Start at login',
      }
    : {
        message: 'Stop starting Anchi’s background service at login?',
        detail:
          'The login item is removed. If login started the service that runs now, it stops with it: running tasks end, and this app starts the service again when it reconnects.',
        button: 'Remove the login item',
      };
  if (!(await deps.confirm(question))) return deps.installed();
  await deps.run(['--server', 'local', 'daemon', on ? 'install' : 'uninstall']);
  return deps.installed();
}
