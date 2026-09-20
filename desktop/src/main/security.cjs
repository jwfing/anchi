const fs = require('node:fs/promises');
const path = require('node:path');
const APP_URL = 'anchi://app/index.html';
const ASSETS = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/style.css': 'style.css',
  '/renderer.mjs': 'renderer.mjs',
  '/views.mjs': 'views.mjs',
});
function trustedSender(event, window) {
  return (
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === APP_URL
  );
}
async function serveAsset(request, directory) {
  const url = new URL(request.url);
  if (
    url.protocol !== 'anchi:' ||
    url.host !== 'app' ||
    request.method !== 'GET' ||
    !Object.hasOwn(ASSETS, url.pathname)
  )
    return new Response('Not found', { status: 404 });
  const file = ASSETS[url.pathname];
  const mime = file.endsWith('.css')
    ? 'text/css'
    : file.endsWith('.mjs')
      ? 'text/javascript'
      : 'text/html';
  return new Response(await fs.readFile(path.join(directory, file)), {
    headers: { 'Content-Type': mime + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}
function hardenSession(session) {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: url.protocol !== 'anchi:' || url.host !== 'app' });
  });
}
function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}
module.exports = { APP_URL, trustedSender, serveAsset, hardenSession, hardenWindow };
