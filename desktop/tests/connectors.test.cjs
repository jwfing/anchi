const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONNECTORS, GOOGLE_SCOPES, byId, isConnector } = require('../src/shared/connectors.cjs');
const { validateHostCommand } = require('../src/main/controller.cjs');

test('descriptor lists the four connectors with auth kinds and token patterns', () => {
  assert.deepEqual(
    CONNECTORS.map((c) => c.id),
    ['gmail', 'drive', 'notion', 'slack'],
  );
  assert.equal(byId('drive').auth, 'google');
  assert.equal(byId('slack').auth, 'token');
  assert(new RegExp(byId('slack').tokenPattern).test('xoxb-' + '1'.repeat(40)));
  assert(!new RegExp(byId('notion').tokenPattern).test('xoxb-' + '1'.repeat(40)));
  assert.equal(isConnector('evil'), false);
  assert.equal(GOOGLE_SCOPES.drive.length, 2);
});

test('token page hints mirror the shared descriptor', () => {
  const page = fs.readFileSync(path.join(__dirname, '../src/renderer/token.mjs'), 'utf8');
  for (const c of CONNECTORS.filter((c) => c.auth === 'token')) {
    assert(page.includes(c.tokenHint), c.id + ' hint');
    assert(
      page.includes(c.tokenPattern.replace(/\\/g, '\\\\')) || page.includes(c.tokenPattern),
      c.id + ' pattern',
    );
  }
});

test('connector operations only accept known connector ids and modes', () => {
  assert.doesNotThrow(() => validateHostCommand('connector-status', { connector: 'drive' }));
  assert.throws(
    () => validateHostCommand('connector-status', { connector: 'evil' }),
    /INVALID_CONNECTOR/,
  );
  assert.throws(
    () => validateHostCommand('connector-read', { connector: 'slack', mode: 'maybe' }),
    /INVALID_MODE/,
  );
  assert.doesNotThrow(() =>
    validateHostCommand('connector-read', { connector: 'slack', mode: 'deny' }),
  );
});
