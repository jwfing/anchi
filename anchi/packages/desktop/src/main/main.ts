import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homeLayout } from '@anchi/core';
import {
  chosenServer,
  connectRemote,
  DaemonClient,
  parseServer,
  saveServer,
  serverName,
  type ServerTarget,
} from '@anchi/daemon/client';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, session, shell } from 'electron';
import { checkCall, externalUrl, NOTIFICATIONS } from './bridge.ts';
import type { ServerState } from '../shared.ts';

const layout = homeLayout();
let window: BrowserWindow | undefined;
let client: DaemonClient | undefined;
let state: ServerState = { name: 'local', status: 'connecting' };
let retry: NodeJS.Timeout | undefined;
/** Bumped by every (re)connection, so a slow attempt never replaces a newer one. */
let generation = 0;

function publish(next: ServerState) {
  state = next;
  window?.webContents.send('anchi:server', state);
}

/** The CLI that starts a local daemon: the checkout's (set by scripts/anchi-desktop) or PATH's. */
function startLocalDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = process.env.ANCHI_CLI ?? 'anchi';
    const child = spawn(cli, ['daemon', 'start'], { stdio: 'ignore' });
    child.on('error', () => reject(new Error(`cannot start the local daemon: ${cli} not found`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cli} daemon start exited with ${code}`)),
    );
  });
}

async function open(server: ServerTarget): Promise<DaemonClient> {
  if (server.kind === 'remote') return connectRemote(server);
  if (process.platform === 'win32') {
    throw new Error('Windows has no local Anchi server: choose a remote server in Settings');
  }
  try {
    return await DaemonClient.connect(layout.socketFile);
  } catch {
    await startLocalDaemon();
    return DaemonClient.connect(layout.socketFile);
  }
}

async function connect(server: ServerTarget) {
  const mine = ++generation;
  clearTimeout(retry);
  client?.close();
  client = undefined;
  publish({ name: serverName(server), status: 'connecting' });
  let next: DaemonClient;
  try {
    next = await open(server);
  } catch (err) {
    if (mine !== generation) return;
    publish({ name: serverName(server), status: 'error', error: (err as Error).message });
    retry = setTimeout(() => void connect(server), 5000);
    return;
  }
  if (mine !== generation) return next.close();
  client = next;
  for (const name of NOTIFICATIONS) {
    next.on(name, (params) => window?.webContents.send('anchi:notify', name, params));
  }
  next.onClose(() => {
    if (mine !== generation) return;
    client = undefined;
    publish({
      name: serverName(server),
      status: 'error',
      error: 'connection to the daemon closed',
    });
    retry = setTimeout(() => void connect(server), 3000);
  });
  publish({ name: serverName(server), status: 'connected' });
}

/** Only the app's own page talks to the main process. */
function fromApp(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents) throw new Error('unknown sender');
}

ipcMain.handle('anchi:call', async (event, method: unknown, params: unknown) => {
  fromApp(event);
  const call = checkCall(method, params);
  if (!client) throw new Error(state.error ?? 'not connected to the Anchi daemon yet');
  return (client.call as (m: string, p: object) => Promise<unknown>).call(
    client,
    call.method,
    call.params,
  );
});
ipcMain.handle('anchi:server', (event) => {
  fromApp(event);
  return state;
});
ipcMain.handle('anchi:setServer', async (event, text: unknown) => {
  fromApp(event);
  const server = parseServer(typeof text === 'string' ? text : '');
  saveServer(layout.root, server);
  await connect(server);
  return state;
});
ipcMain.handle('anchi:openExternal', async (event, url: unknown) => {
  fromApp(event);
  const href = externalUrl(url);
  if (href) await shell.openExternal(href);
});

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Anchi',
    backgroundColor: '#F4F5F7',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // The page never leaves the app: links open in the browser through anchi:openExternal.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => (window = undefined));
  void window.loadFile(join(__dirname, 'renderer/index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  createWindow();
  let server: ServerTarget;
  try {
    server = chosenServer(layout.root, process.env.ANCHI_DESKTOP_SERVER);
  } catch (err) {
    publish({ name: 'local', status: 'error', error: (err as Error).message });
    return;
  }
  void connect(server);
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  generation++;
  client?.close();
});
