const { t, text: msg, getLocale } = require('./language.cjs');
const { BrowserWindow, ipcMain } = require('electron');
const { TOKEN_URL, trustedSender, hardenWindow } = require('./security.cjs');

/**
 * A separate hardened window collects a static token. The value travels renderer(token page) →
 * main → guest stdin; it never reaches the main page where agent content is rendered.
 */
class TokenWindow {
  constructor({ parent, preload }) {
    Object.assign(this, { parent, preload });
  }
  prompt(descriptor) {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        parent: this.parent,
        modal: true,
        width: 560,
        height: 460,
        resizable: false,
        title: msg`输入 ${descriptor.label} 令牌`,
        webPreferences: {
          preload: this.preload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      hardenWindow(win);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        ipcMain.removeHandler('desktop:token');
        resolve(value);
        if (!win.isDestroyed()) win.close();
      };
      ipcMain.removeHandler('desktop:token');
      ipcMain.handle('desktop:token', (event, value) => {
        if (!trustedSender(event, win, TOKEN_URL)) throw Error('UNTRUSTED_SENDER');
        if (value === null) {
          finish(null);
          return { ok: true };
        }
        if (typeof value !== 'string' || !new RegExp(descriptor.tokenPattern).test(value))
          throw Error('BAD_TOKEN_FORMAT');
        finish(value);
        return { ok: true };
      });
      win.once('closed', () => finish(null));
      void win.loadURL(
        `${TOKEN_URL}?connector=${encodeURIComponent(descriptor.id)}&locale=${getLocale()}`,
      );
    });
  }
}
module.exports = { TokenWindow };
