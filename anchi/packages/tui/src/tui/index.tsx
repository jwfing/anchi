/** @jsxRuntime automatic */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonClient } from '@anchi/daemon';
import { render } from 'ink';
import { App, type AppProps } from './App.tsx';
import { loadKeyMap, watchKeyMap } from './keyconfig.ts';
import { captureMouse, MOUSE_OFF, MOUSE_ON, type MouseEvent } from './mouse.ts';

/** Composes a message in $EDITOR: the fallback when a terminal's IME input misbehaves. */
export function composeInEditor(draft: string): string {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const dir = mkdtempSync(join(tmpdir(), 'anchi-compose-'));
  const file = join(dir, 'message.md');
  writeFileSync(file, draft, { mode: 0o600 });
  process.stdout.write(MOUSE_OFF);
  try {
    spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'editor', file], { stdio: 'inherit' });
    return readFileSync(file, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(MOUSE_ON);
  }
}

/**
 * Full-screen client. Quitting leaves the daemon and running tasks alive. Key bindings come from
 * `keysFile` and follow its changes while the client runs.
 */
export async function runTui(client: DaemonClient, keysFile?: string): Promise<void> {
  const [agents, tasks] = await Promise.all([
    client.call('agents.list'),
    client.call('tasks.list', { limit: 500 }),
  ]);
  let mouseHandler: ((e: MouseEvent) => void) | undefined;
  const releaseMouse = process.stdin.isTTY
    ? captureMouse(process.stdin, process.stdout, (e) => mouseHandler?.(e))
    : () => {};
  const app = (keys: Pick<AppProps, 'keymap' | 'keyWarnings'>) => (
    <App
      client={client}
      initialAgents={agents}
      initialTasks={tasks}
      onMouse={(h) => {
        mouseHandler = h;
      }}
      compose={composeInEditor}
      keymap={keys.keymap}
      keyWarnings={keys.keyWarnings}
    />
  );
  const load = (r: ReturnType<typeof loadKeyMap>) => ({
    keymap: r.keymap,
    keyWarnings: r.warnings,
  });
  const instance = render(app(keysFile ? load(loadKeyMap(keysFile)) : {}), {
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: true,
  });
  const stopWatching = keysFile
    ? watchKeyMap(keysFile, (r) => instance.rerender(app(load(r))))
    : () => {};
  try {
    await instance.waitUntilExit();
  } finally {
    stopWatching();
    releaseMouse();
    client.close();
  }
}
