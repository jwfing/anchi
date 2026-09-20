const { app, BrowserWindow, ipcMain, dialog, protocol, session, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { Setup } = require('./setup.cjs');
const { Runtime, resolveRuntime } = require('./runtime.cjs');
const { DirectoryStore } = require('./directory-store.cjs');
const { FileBroker } = require('./file-broker.cjs');
const { DesktopOAuth } = require('./oauth.cjs');
const { PiClient } = require('./pi-client.cjs');
const { Controller } = require('./controller.cjs');
const {
  APP_URL,
  trustedSender,
  serveAsset,
  hardenSession,
  hardenWindow,
} = require('./security.cjs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'anchi', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName('Anchi');
// Keep the existing profile and single-instance lock across the product rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Qisuo'));
let win,
  pi,
  setup,
  closing = false,
  confirmingClose = false;

async function start() {
  const runtime = new Runtime(
    await resolveRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
  );
  const directories = new DirectoryStore(
    path.join(app.getPath('userData'), 'directory-plans.json'),
    await fs.realpath(os.homedir()),
  );
  let settingsError = false;
  try {
    await directories.load();
  } catch {
    settingsError = true;
  }
  const notify = (event) => {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:event', event);
  };
  let controller;
  setup = new Setup({
    runtime,
    userData: app.getPath('userData'),
    notify: (event) => controller.emit(event),
  });
  await setup.load();
  const files = new FileBroker({ directories, runtime, notify: (event) => controller.emit(event) });
  const oauth = new DesktopOAuth({
    runtime,
    openExternal: (url) => shell.openExternal(url),
    notify: (event) => controller.emit(event),
  });
  app.on('will-quit', () => {
    void oauth.cancel().catch(() => {});
  });
  pi = new PiClient({ runtime, files, notify: (event) => controller.emit(event) });
  controller = new Controller({
    runtime,
    setup,
    directories,
    files,
    oauth,
    pi,
    notify,
    dialogs: {
      async openDependencyInstaller() {
        await shell.openExternal('https://github.com/Homebrew/brew/releases/latest');
      },
      async confirmSetup(action) {
        const details = {
          dependencies: '安装 Lima、Python 和 Codex CLI。软件从 Homebrew 下载，会占用磁盘空间。',
          install:
            '创建或更新本机 Linux 环境并安装 Pi。分配 4 GB 内存和最多 30 GB 虚拟磁盘，下载可能需要数分钟。已有凭证和工作区保留。',
          unlock:
            '在本机创建或使用已有主密钥，解锁 VM 内凭证库。请保留 ~/.config/secure-vm/vault.key；丢失后需重新连接账户。',
          login:
            '打开 Codex 的浏览器登录，使用本机 Codex 账户缓存。短期访问令牌加密导入 VM，刷新令牌不会交给 Pi。',
          import: '读取本机已有 Codex 订阅登录，仅将短期访问令牌导入 VM。',
        };
        if (!Object.hasOwn(details, action)) throw Error('INVALID_SETUP_ACTION');
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          message: '继续设置 Pi？',
          detail: details[action],
          buttons: ['取消', '继续'],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
      async chooseDirectory() {
        const result = await dialog.showOpenDialog(win, {
          title: '授权 Agent 访问所选目录',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory'],
        });
        if (result.canceled) return null;
        return result.filePaths[0];
      },
      async confirmDirectory(item) {
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          message: `允许 Agent ${item.mode === 'rw' ? '读写（含覆盖和删除文件）' : '读取'}此目录？`,
          detail: item.path,
          buttons: ['取消', '授权'],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
      async chooseClient() {
        const result = await dialog.showOpenDialog(win, {
          title: '导入 Google Desktop OAuth 客户端 JSON',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled) return null;
        const handle = await fs.open(
          result.filePaths[0],
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 16384) throw Error('INVALID_CLIENT_FILE');
          return JSON.parse(await handle.readFile('utf8'));
        } finally {
          await handle.close();
        }
      },
      async confirmGmail() {
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          message: '允许 Agent 持续读取 Gmail？',
          detail:
            '允许列出和读取邮件，不允许发送或修改。邮件内容可能被加入模型请求，模型调用仍需审批。',
          buttons: ['取消', '允许只读'],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      },
      async confirmApproval({ id, decision, detail }) {
        const result = await dialog.showMessageBox(win, {
          type: 'question',
          title: '独立权限审批',
          message:
            decision === 'approve'
              ? '批准当前已查看的请求？'
              : `确认${decision === 'deny' ? '拒绝' : '撤销'}该请求？`,
          detail: `ID: ${id}\nDigest: ${detail.digest}\n\n请先核对审批页完整动作。批准可能向模型发送所列内容并产生费用。`,
          buttons: ['取消', '确认'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1;
      },
    },
  });
  if (settingsError)
    controller.activity('目录配置损坏或版本不兼容，已保留原文件且禁用配置写入。请备份并恢复配置。');

  protocol.handle('anchi', (request) => serveAsset(request, path.join(__dirname, '../renderer')));
  hardenSession(session.defaultSession);
  win = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 850,
    minHeight: 620,
    title: '安栖 · 本地 Agent',
    backgroundColor: '#f5f6f0',
    webPreferences: {
      preload: path.join(__dirname, '../preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  hardenWindow(win);
  ipcMain.handle('desktop:command', async (event, op, args) => {
    if (!trustedSender(event, win)) throw Error('UNTRUSTED_SENDER');
    try {
      return await controller.dispatch(op, args);
    } catch (error) {
      throw Error(/^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED');
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: '安栖', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]),
  );
  win.on('close', (event) => {
    if (setup.busy) {
      event.preventDefault();
      void dialog.showMessageBox(win, {
        message: '设置正在进行，请等待完成。浏览器登录可在首次设置页取消。',
      });
      return;
    }
    if (closing || !pi.child) return;
    event.preventDefault();
    if (confirmingClose) return;
    confirmingClose = true;
    void (async () => {
      try {
        const choice = await dialog.showMessageBox(win, {
          type: 'question',
          message: '结束 Pi 连接并退出？',
          detail: '本地任务将停止。VM 保持运行，远端在途操作可能继续完成。',
          buttons: ['保留窗口', '停止并退出'],
          defaultId: 0,
          cancelId: 0,
        });
        if (choice.response === 1) {
          closing = true;
          await pi.disconnect();
          app.quit();
        }
      } finally {
        confirmingClose = false;
      }
    })();
  });
  await win.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      closing = true;
      dialog.showErrorBox('无法启动安栖', '请检查运行资源是否完整。\n' + error.message);
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if ((setup?.busy || pi?.child) && !closing) {
      event.preventDefault();
      win?.close();
    }
  });
}
