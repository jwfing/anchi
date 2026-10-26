import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homeLayout } from '@anchi/core';
import {
  addServer,
  chosenServer,
  connectRemote,
  DaemonClient,
  listServers,
  probeServer,
  removeServer,
  resolveServer,
  saveServer,
  serverName,
  type ServerTarget,
} from '@anchi/daemon/client';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  nativeImage,
  session,
  shell,
} from 'electron';
import { checkCall, type Confirmation, externalUrl, guardedCall, NOTIFICATIONS } from './bridge.ts';
import { adoptLoginPath } from './env.ts';
import type { ServerState } from '../shared.ts';

const layout = homeLayout();

// Run as `electron dist/main.cjs`, the app would be called Electron and share that generic
// profile; ~/…/Anchi belongs to the retired 0.1 app. A --user-data-dir (checks) wins.
app.setName('Anchi');
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'Anchi Desktop'));
}
const icon = join(__dirname, 'icon.png');
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

/**
 * The CLI that starts a local daemon: the checkout's (set by scripts/anchi-desktop) or PATH's,
 * which for the packaged app includes the installer's directories.
 */
function startLocalDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = process.env.ANCHI_CLI ?? 'anchi';
    const child = spawn(cli, ['daemon', 'start'], { stdio: 'ignore' });
    child.on('error', () =>
      reject(
        new Error(
          `cannot start the local daemon: ${cli} not found. Install the Anchi CLI (curl -fsSL https://anchi.elseward.xyz/install.sh | sh), or use a remote server`,
        ),
      ),
    );
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
  const daemon = client;
  if (!daemon) {
    checkCall(method, params);
    throw new Error(state.error ?? 'not connected to the Anchi daemon yet');
  }
  return guardedCall(
    method,
    params,
    (m, p) => (daemon.call as (m: string, p: object) => Promise<unknown>).call(daemon, m, p),
    confirm,
  );
});

async function confirm(question: Confirmation): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    message: question.message,
    detail: question.detail,
    buttons: ['Cancel', question.button],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}
/**
 * A skill folder on this computer, chosen in a native picker: the window never names a host path.
 * A remote server would read the path on its own disk, so this is for the local server only.
 */
ipcMain.handle('anchi:addSkillFolder', async (event) => {
  fromApp(event);
  if (state.name !== 'local') throw new Error('add folders on the server with anchi skills add');
  if (!client) throw new Error(state.error ?? 'not connected to the Anchi daemon yet');
  const options = { title: 'Add a skill folder', properties: ['openDirectory' as const] };
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return null;
  return client.call('skills.add', { source: picked.filePaths[0] });
});
/**
 * A Google OAuth client JSON, chosen in a native picker and read here: the window never names a
 * host path. Its contents go to the daemon, so this works for a remote server too.
 */
ipcMain.handle('anchi:importGoogleClient', async (event) => {
  fromApp(event);
  if (!client) throw new Error(state.error ?? 'not connected to the Anchi daemon yet');
  const options = {
    title: 'Choose the Google OAuth client JSON',
    properties: ['openFile' as const],
    filters: [{ name: 'OAuth client', extensions: ['json'] }],
  };
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const path = picked.filePaths[0];
  if (picked.canceled || !path) return false;
  if ((await stat(path)).size > 16_384) throw new Error('that file is too large for a client JSON');
  await client.call('services.googleClient', { json: await readFile(path, 'utf8') });
  return true;
});
ipcMain.handle('anchi:server', (event) => {
  fromApp(event);
  return state;
});
ipcMain.handle('anchi:setServer', async (event, text: unknown) => {
  fromApp(event);
  const server = resolveServer(layout.root, typeof text === 'string' ? text : '');
  saveServer(layout.root, server);
  await connect(server);
  return state;
});
ipcMain.handle('anchi:servers', (event) => {
  fromApp(event);
  return listServers(layout.root);
});
/** Saves a server and tries it once, without switching to it. */
ipcMain.handle('anchi:addServer', async (event, name: unknown, target: unknown) => {
  fromApp(event);
  const saved = addServer(layout.root, String(name ?? ''), String(target ?? ''));
  const server = resolveServer(layout.root, saved.target);
  const probe = server.kind === 'remote' ? await probeServer(server) : { kind: 'ok' as const };
  return { saved, probe };
});
ipcMain.handle('anchi:removeServer', async (event, name: unknown) => {
  fromApp(event);
  const gone = removeServer(layout.root, String(name ?? ''));
  if (state.name === gone.target) await connect({ kind: 'local' });
  return listServers(layout.root);
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
    // X11 drops a window icon this large (the 1024 px dock image): give windows a small copy.
    icon: nativeImage.createFromPath(icon).resize({ width: 128 }),
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

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  app.dock?.setIcon(icon);
  createWindow();
  if (app.isPackaged) await adoptLoginPath();
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
