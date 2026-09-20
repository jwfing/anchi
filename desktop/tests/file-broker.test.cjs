const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FileBroker } = require('../src/main/file-broker.cjs');
test('unknown grants fail closed and queued access is revoked before execution', async () => {
  let finish;
  const broker = new FileBroker({
    directories: { directories: [] },
    runtime: {
      root: '/runtime',
      input: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, result: { text: 'x' } });
        }),
    },
  });
  await assert.rejects(
    broker.request({ op: 'read', grant: 'unknown', path: 'x' }),
    /DIRECTORY_NOT_AUTHORIZED/,
  );
  broker.grants.set('g', { id: 'g', path: '/allowed', mode: 'ro' });
  const first = broker.request({ op: 'read', grant: 'g', path: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  const next = broker.request({ op: 'read', grant: 'g', path: 'x' });
  const rejected = assert.rejects(next, /DIRECTORY_NOT_AUTHORIZED/);
  let revoked = false;
  const revoke = broker.revoke('g').then(() => {
    revoked = true;
  });
  assert.equal(revoked, false);
  finish();
  await first;
  await rejected;
  await revoke;
  assert.equal(revoked, true);
  assert.deepEqual(await broker.request({ op: 'grants' }), { grants: [] });
});
