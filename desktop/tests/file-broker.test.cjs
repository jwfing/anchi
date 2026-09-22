const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileBroker } = require('../src/main/file-broker.cjs');
test('unknown grants fail closed and queued access is revoked before execution', async () => {
  let finish;
  const used = [];
  const broker = new FileBroker({
    directories: { directories: [] },
    runtime: {
      root: '/runtime',
      python: async () => '/trusted/python3',
      input: (file) => {
        used.push(file);
        return new Promise((resolve) => {
          finish = () => resolve({ ok: true, result: { text: 'x' } });
        });
      },
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
  // The broker runs the same host interpreter first-run setup installs, never a fixed system path.
  assert.deepEqual(used, ['/trusted/python3']);
});

test('persisted grants restore only for the identical directory; consent pins identity', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-broker-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const docs = path.join(base, 'docs');
  await fs.mkdir(docs);
  const stat = await fs.stat(docs, { bigint: true });
  const identity = [String(stat.dev), String(stat.ino)];
  const recorded = [];
  const directories = {
    directories: [
      { id: 'fresh', path: docs, mode: 'ro' },
      { id: 'same', path: docs, mode: 'ro', identity },
      { id: 'moved', path: docs, mode: 'rw', identity: [identity[0], '1'] },
      { id: 'gone', path: path.join(base, 'missing'), mode: 'ro', identity },
    ],
    recordIdentity: async (id, value) => {
      recorded.push([id, value]);
    },
  };
  const broker = new FileBroker({ directories, runtime: { root: '/runtime' } });
  const errors = await broker.restore();
  assert.deepEqual([...broker.grants.keys()], ['same']);
  assert.equal(errors.get('fresh'), 'CONSENT_REQUIRED');
  assert.equal(errors.get('moved'), 'DIRECTORY_CHANGED');
  assert.equal(errors.get('gone'), 'DIRECTORY_UNAVAILABLE');
  assert.deepEqual(recorded, []);
  // Explicit consent re-pins the identity for a moved directory and clears its restore error.
  await broker.activate('moved');
  assert.deepEqual(recorded, [['moved', identity]]);
  assert.equal(errors.has('moved'), false);
  await broker.activate('fresh');
  assert.deepEqual(recorded[1], ['fresh', identity]);
});

test('persisted write grants overlapping runtime stay inactive after upgrade', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-protected-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const directory = await fs.realpath(temp);
  const stat = await fs.stat(directory, { bigint: true });
  const directories = {
    protectedPaths: [path.join(directory, 'runtime')],
    directories: [
      { id: 'g', path: directory, mode: 'rw', identity: [String(stat.dev), String(stat.ino)] },
    ],
  };
  const broker = new FileBroker({ directories, runtime: {} });
  const errors = await broker.restore();
  assert.equal(errors.get('g'), 'RUNTIME_DIRECTORY_NOT_ALLOWED');
  assert.equal(broker.grants.size, 0);
  await assert.rejects(broker.activate('g'), /RUNTIME_DIRECTORY_NOT_ALLOWED/);
  directories.directories[0].mode = 'ro';
  await broker.activate('g', { confirmed: false });
  assert.equal(broker.grants.get('g').mode, 'ro');
});
