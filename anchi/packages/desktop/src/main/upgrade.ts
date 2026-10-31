import { spawn } from 'node:child_process';
import { sanitizeLine } from '@anchi/core';
import type { DaemonStatus, SetupStatus, TaskRow } from '@anchi/protocol';
import type { Confirmation, Read } from './bridge.ts';
import { compareVersions } from './updates.ts';
import type { ServerState } from '../shared.ts';

/**
 * Runs on a remote release install over SSH. It checks again that no cell runs, updates the
 * installer-managed copy, points the login service at it and restarts the daemon.
 */
export const REMOTE_UPGRADE = `set -eu
export PATH="$HOME/.local/bin:$PATH"
command -v anchi-bridge >/dev/null || { echo 'Anchi is not initialized on this machine.' >&2; exit 1; }
cells=$(anchi --server local daemon status 2>/dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin)["cells"])')
[ "$cells" = 0 ] || { echo 'Tasks are running on this machine; upgrade after they finish.' >&2; exit 1; }
anchi update
ANCHI_GUEST=local anchi --server local daemon install
systemctl --user restart anchi-daemon.service
echo 'The Anchi daemon restarted.'`;

/**
 * Runs on this computer with the CLI as $1. The app starts the stopped daemon again when it
 * reconnects; a login service is rewritten to the new version first.
 */
export const LOCAL_UPGRADE = `set -eu
anchi=$1
"$anchi" update
"$anchi" --server local daemon stop || true
if [ -f "$HOME/Library/LaunchAgents/dev.anchi.daemon.plist" ] || [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/anchi-daemon.service" ]; then
  "$anchi" --server local daemon install
fi`;

/** Runs a fixed script; only its last output, sanitized, reaches an error message. */
export function runScript(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000 });
    let output = '';
    const collect = (data: Buffer) => {
      output = (output + data.toString('utf8')).slice(-8000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${label} failed (${signal ?? code}): ${sanitizeLine(output).slice(-4000)}`),
        );
    });
  });
}

/** Refuses while a cell runs or a task is queued or running: an upgrade restarts the daemon. */
async function idle(read: Read, label: string) {
  const status = (await read('daemon.status', {})) as DaemonStatus;
  const busy = [];
  for (const state of ['running', 'queued'] as const) {
    busy.push(...((await read('tasks.search', { status: state, limit: 1 })) as TaskRow[]));
  }
  if (status.cells > 0 || busy.length > 0) {
    throw new Error(`${label} has tasks running. Upgrade it after they finish.`);
  }
  return status;
}

/** Upgrades one machine at a time; the window decides nothing but which machine. */
export class ServerUpgrade {
  private running = new Set<string>();

  constructor(
    private opts: {
      state(target: string): ServerState | undefined;
      latest(): string | null;
      lease(target: string): { read: Read };
      pin(target: string): () => void;
      confirm(question: Confirmation): Promise<boolean>;
      run(target: string): Promise<void>;
      reconnect(target: string): Promise<void>;
      /** Resolves with the state once `ready` holds, or rejects after the timeout. */
      wait(target: string, ready: (state: ServerState) => boolean): Promise<ServerState>;
      changed(): void;
    },
  ) {}

  busy(target: string) {
    return this.running.has(target);
  }

  /** The latest release, if a connected machine's daemon is behind it. */
  newer(state: ServerState): string | undefined {
    const latest = this.opts.latest();
    return state.status === 'connected' &&
      state.version &&
      latest &&
      compareVersions(latest, state.version) === 1
      ? latest
      : undefined;
  }

  async upgrade(input: unknown): Promise<boolean> {
    const state = typeof input === 'string' ? this.opts.state(input) : undefined;
    if (!state) throw new Error('unknown machine: choose a saved machine');
    const target = state.name;
    const label = sanitizeLine(state.label);
    if (this.running.has(target)) throw new Error('an upgrade is already running');
    const status = await idle(this.opts.lease(target).read, label);
    if (status.install !== 'release') {
      throw new Error(
        `${label} runs Anchi from a source checkout. Upgrade it from the checkout (${
          target === 'local' ? 'git pull' : `scripts/remote.sh ${target}`
        }).`,
      );
    }
    const version = this.newer({ ...state, version: status.version });
    if (!version) throw new Error(`${label} already runs the latest Anchi release.`);
    const current = this.opts.pin(target);
    const local = target === 'local';
    if (
      !(await this.opts.confirm({
        message: `Upgrade ${label} to Anchi ${version}?`,
        detail:
          `Machine: ${label}${local ? '' : ` (${target})`}\nAnchi ${status.version} → ${version}\n\n` +
          `Anchi installs the verified ${version} release${local ? ', including this app,' : ''} and restarts the daemon, then updates the VM's components, which can take several minutes. ` +
          'No task may start until it finishes. Agents, task history and credentials are kept.' +
          (local ? '\n\nReopen Anchi afterwards to use the new app.' : ''),
        button: 'Upgrade',
      }))
    )
      return false;
    current();
    this.running.add(target);
    this.opts.changed();
    try {
      // A task may have started while the dialog was open.
      await idle(this.opts.lease(target).read, label);
      await this.opts.run(target);
      await this.opts.reconnect(target);
      await this.opts.wait(
        target,
        (s) =>
          s.status === 'connected' &&
          !!s.version &&
          (compareVersions(s.version, version) ?? -1) >= 0,
      );
      const read = this.opts.lease(target).read;
      const setup = (await read('setup.status', {})) as SetupStatus;
      if (setup.installed && setup.guestOutdated) {
        await read('setup.prepare', {
          runtime: setup.preparedRuntimes?.[0] ?? 'codex',
          confirm: true,
        });
      }
      return true;
    } finally {
      this.running.delete(target);
      this.opts.changed();
    }
  }
}
