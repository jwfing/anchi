import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homeLayout, sanitizeLine } from '@anchi/core';
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
import { type Confirmation, externalUrl } from './bridge.ts';
import { Connections } from './connections.ts';
import { adoptLoginPath } from './env.ts';
import { bootstrapServer, ServerSetup } from './server-setup.ts';
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
let selected = 'local';
const connections = new Connections({
  open: async (target) => {
    const client = await open(resolveServer(layout.root, target));
    return {
      read: (method, params) => client.call(method, params),
      on: (name, listener) => {
        client.on(name, listener);
      },
      onClose: (listener) => {
        client.onClose(listener);
      },
      close: () => client.close(),
    };
  },
  changed: (states) => window?.webContents.send('anchi:connections', states),
  notify: (server, name, params) => window?.webContents.send('anchi:notify', server, name, params),
});

const serverSetup = new ServerSetup({
  servers: () => listServers(layout.root),
  pin: (target) => connections.pin(target),
  probe: probeServer,
  confirm,
  install: async (target) => {
    connections.setupState(target.name, 'installing');
    await bootstrapServer(target, join(__dirname, 'remote'));
  },
  connect: async (target) => {
    connections.disconnect(target);
    await connections.connect(target);
  },
});

async function initializeServer(target: unknown): Promise<boolean> {
  if (typeof target === 'string' && serverSetup.busy(target))
    throw new Error('initialization is already running');
  try {
    return await serverSetup.initialize(target);
  } catch (err) {
    if (
      typeof target === 'string' &&
      connections
        .states()
        .some((s) => s.name === target && (s.status === 'installing' || s.status === 'needs-setup'))
    ) {
      connections.setupState(
        target,
        'needs-setup',
        sanitizeLine(err instanceof Error ? err.message : 'Initialization failed'),
      );
    }
    throw err;
  }
}

function selectedState(): ServerState {
  return (
    connections.states().find((s) => s.name === selected) ?? {
      name: selected,
      label: selected,
      status: 'disconnected',
    }
  );
}

/**
 * The CLI that starts a local daemon: the checkout's (set by scripts/anchi-desktop) or PATH's,
 * which for the packaged app includes the installer's directories.
 */
function startLocalDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = process.env.ANCHI_CLI ?? 'anchi';
    const child = spawn(cli, ['--server', 'local', 'daemon', 'start'], { stdio: 'ignore' });
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

/** Only the app's own page talks to the main process. */
function fromApp(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents) throw new Error('unknown sender');
}

ipcMain.handle('anchi:call', async (event, server: unknown, method: unknown, params: unknown) => {
  fromApp(event);
  return connections.call(server, method, params, confirm);
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
ipcMain.handle('anchi:addSkillFolder', async (event, server: unknown) => {
  fromApp(event);
  if (server !== 'local') throw new Error('add folders on the server with anchi skills add');
  const lease = connections.lease(server);
  const options = { title: 'Add a skill folder', properties: ['openDirectory' as const] };
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return null;
  return lease.read('skills.add', { source: picked.filePaths[0] });
});
/**
 * A Google OAuth client JSON, chosen in a native picker and read here: the window never names a
 * host path. Its contents go to the daemon, so this works for a remote server too.
 */
ipcMain.handle('anchi:importGoogleClient', async (event, server: unknown) => {
  fromApp(event);
  const lease = connections.lease(server);
  const options = {
    title: `Choose the Google OAuth client JSON for ${lease.state.label}`,
    properties: ['openFile' as const],
    filters: [{ name: 'OAuth client', extensions: ['json'] }],
  };
  const picked = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const path = picked.filePaths[0];
  if (picked.canceled || !path) return false;
  if ((await stat(path)).size > 16_384) throw new Error('that file is too large for a client JSON');
  await lease.read('services.googleClient', { json: await readFile(path, 'utf8') });
  return true;
});
ipcMain.handle('anchi:server', (event) => {
  fromApp(event);
  return selectedState();
});
ipcMain.handle('anchi:connections', (event) => {
  fromApp(event);
  return connections.states();
});
ipcMain.handle('anchi:connectServer', async (event, target: unknown, connected: unknown) => {
  fromApp(event);
  if (
    typeof target !== 'string' ||
    typeof connected !== 'boolean' ||
    !connections.states().some((s) => s.name === target)
  )
    throw new Error('unknown machine');
  if (serverSetup.busy(target)) throw new Error('initialization is already running');
  if (connected) await connections.connect(target);
  else connections.disconnect(target);
});
ipcMain.handle('anchi:setServer', async (event, text: unknown) => {
  fromApp(event);
  if (typeof text !== 'string' || !text) throw new Error('unknown machine');
  const server = resolveServer(layout.root, text);
  const target = serverName(server);
  if (!connections.states().some((s) => s.name === target)) throw new Error('unknown machine');
  selected = target;
  saveServer(layout.root, server);
  return selectedState();
});
ipcMain.handle('anchi:servers', (event) => {
  fromApp(event);
  return listServers(layout.root);
});
/** Saves a server, then offers first-time initialization if its bridge is missing. */
ipcMain.handle('anchi:addServer', async (event, name: unknown, target: unknown) => {
  fromApp(event);
  const saved = addServer(layout.root, String(name ?? ''), String(target ?? ''));
  connections.add(saved);
  await connections.connect(saved.target);
  const server = resolveServer(layout.root, saved.target);
  const probe = server.kind === 'remote' ? await probeServer(server) : { kind: 'ok' as const };
  if (probe.kind === 'bridge-missing') {
    try {
      if (await initializeServer(saved.target)) return { saved, probe: { kind: 'ok' as const } };
    } catch {
      // Keep the saved machine and its setup error visible so initialization can be retried.
    }
  }
  return { saved, probe };
});
ipcMain.handle('anchi:initializeServer', (event, target: unknown) => {
  fromApp(event);
  return initializeServer(target);
});
ipcMain.handle('anchi:removeServer', async (event, name: unknown) => {
  fromApp(event);
  const saved = listServers(layout.root).find((s) => s.name === name);
  if (saved && serverSetup.busy(saved.target)) throw new Error('initialization is already running');
  const gone = removeServer(layout.root, String(name ?? ''));
  connections.remove(gone.target);
  if (selected === gone.target) selected = 'local';
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
  const saved = listServers(layout.root);
  for (const entry of saved) connections.add(entry);
  try {
    const server = chosenServer(layout.root, process.env.ANCHI_DESKTOP_SERVER);
    selected = serverName(server);
    if (!saved.some((s) => s.target === selected)) {
      connections.add({ name: selected, target: selected });
    }
  } catch {
    selected = 'local';
  }
  for (const state of connections.states()) void connections.connect(state.name);
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  connections.close();
});
