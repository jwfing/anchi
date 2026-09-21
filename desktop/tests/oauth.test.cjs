const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DesktopOAuth, validateAuthorization } = require('../src/main/oauth.cjs');
function authorization(redirect) {
  const state = 's'.repeat(48);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  Object.entries({
    state,
    redirect_uri: redirect,
    code_challenge_method: 'S256',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    response_type: 'code',
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  return { state, url: url.href };
}
function get(url, headers) {
  return new Promise((resolve, reject) =>
    http
      .get(url, { headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject),
  );
}
test('authorization only opens exact Google endpoint and readonly PKCE flow', () => {
  const redirect = 'http://127.0.0.1:1234/callback';
  const value = authorization(redirect);
  assert.equal(validateAuthorization(value, redirect), value.url);
  const drive = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ];
  const driveUrl = new URL(value.url);
  driveUrl.searchParams.set('scope', drive.join(' '));
  assert.equal(
    validateAuthorization({ ...value, url: driveUrl.href }, redirect, drive),
    driveUrl.href,
  );
  driveUrl.searchParams.set('scope', drive[0]);
  assert.throws(() => validateAuthorization({ ...value, url: driveUrl.href }, redirect, drive));
  for (const url of [
    value.url.replace('accounts.google.com', 'evil.example'),
    value.url.replace('S256', 'plain'),
    value.url.replace('gmail.readonly', 'gmail.modify'),
  ])
    assert.throws(() => validateAuthorization({ ...value, url }, redirect));
});
test('loopback validates state and Host, exchanges once, never emits code', async (t) => {
  const calls = [],
    events = [];
  let opened;
  const oauth = new DesktopOAuth({
    runtime: {
      async auth(op, value) {
        calls.push({ op, value });
        return op === 'begin' ? authorization(value.redirect_uri) : {};
      },
    },
    openExternal: async (url) => {
      opened = url;
    },
    notify: (e) => events.push(e),
  });
  t.after(() => oauth.cancel().catch(() => {}));
  await oauth.begin();
  const url = new URL(opened),
    callback = new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', 'bad');
  callback.searchParams.set('code', 'secret-code');
  assert.equal(await get(callback), 400);
  callback.searchParams.set('state', url.searchParams.get('state'));
  assert.equal(await get(callback, { Host: 'evil.example' }), 400);
  assert.equal(await get(callback), 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((c) => c.op === 'complete').length, 1);
  assert(!JSON.stringify(events).includes('secret-code'));
  assert.equal(oauth.state.pending, false);
});
test('cancel clears listener and encrypted pending state', async () => {
  const calls = [];
  const oauth = new DesktopOAuth({
    runtime: {
      async auth(op, v) {
        calls.push(op);
        return op === 'begin' ? authorization(v.redirect_uri) : {};
      },
    },
    openExternal: async () => {},
    notify: () => {},
  });
  await oauth.begin();
  await oauth.cancel();
  assert.deepEqual(calls, ['begin', 'cancel']);
  assert.equal(oauth.flow, null);
});
