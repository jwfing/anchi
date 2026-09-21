const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { APP_URL, TOKEN_URL, trustedSender, serveAsset } = require('../src/main/security.cjs');
test('only the exact top-level application frame can call privileged IPC', () => {
  const frame = { url: APP_URL },
    wc = { mainFrame: frame },
    win = { isDestroyed: () => false, webContents: wc };
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, win), true);
  assert.equal(trustedSender({ sender: wc, senderFrame: { url: APP_URL } }, win), false);
  frame.url = 'https://evil.test';
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, win), false);
});
test('protocol serves only packaged assets; rejects arbitrary files and methods', async () => {
  const directory = path.resolve(__dirname, '../src/renderer');
  for (const url of [
    'anchi://app/secrets.json',
    'anchi://other/index.html',
    'anchi://app/__proto__',
  ])
    assert.equal((await serveAsset({ url, method: 'GET' }, directory)).status, 404);
  assert.equal((await serveAsset({ url: APP_URL, method: 'POST' }, directory)).status, 404);
  const page = await serveAsset({ url: APP_URL, method: 'GET' }, directory);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /connect-src 'none'/);
  for (const file of ['renderer.mjs', 'views.mjs']) {
    const module = await serveAsset({ url: `anchi://app/${file}`, method: 'GET' }, directory);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /text\/javascript/);
  }
});

test('token window is served and only its own frame may submit a token', async () => {
  const directory = path.resolve(__dirname, '../src/renderer');
  const page = await serveAsset({ url: TOKEN_URL + '?connector=slack', method: 'GET' }, directory);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /connect-src 'none'/);
  const script = await serveAsset({ url: 'anchi://app/token.mjs', method: 'GET' }, directory);
  assert.equal(script.status, 200);
  const frame = { url: TOKEN_URL + '?connector=slack' },
    wc = { mainFrame: frame },
    win = { isDestroyed: () => false, webContents: wc };
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, win, TOKEN_URL), true);
  assert.equal(trustedSender({ sender: wc, senderFrame: frame }, win), false);
  assert.equal(trustedSender({ sender: wc, senderFrame: { url: APP_URL } }, win, TOKEN_URL), false);
});
