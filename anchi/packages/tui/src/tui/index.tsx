/** @jsxRuntime automatic */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonClient } from '@anchi/daemon';
import { render } from 'ink';
import { App } from './App.tsx';
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

/** Full-screen client. Quitting leaves the daemon and running tasks alive. */
export async function runTui(client: DaemonClient): Promise<void> {
  const [agents, tasks] = await Promise.all([
    client.call('agents.list'),
    client.call('tasks.list', { limit: 200 }),
  ]);
  let mouseHandler: ((e: MouseEvent) => void) | undefined;
  const releaseMouse = process.stdin.isTTY
    ? captureMouse(process.stdin, process.stdout, (e) => mouseHandler?.(e))
    : () => {};
  const instance = render(
    <App
      client={client}
      initialAgents={agents}
      initialTasks={tasks}
      onMouse={(h) => {
        mouseHandler = h;
      }}
      compose={composeInEditor}
    />,
    { alternateScreen: true, exitOnCtrlC: false, patchConsole: true },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    releaseMouse();
    client.close();
  }
}
