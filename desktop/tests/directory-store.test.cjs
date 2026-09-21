const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DirectoryStore, validateDirectory } = require('../src/main/directory-store.cjs');
const { describe } = require('../src/main/platform.cjs');
const mac = (home) => describe({ platform: 'darwin', arch: 'arm64', home });
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-store-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  await fs.mkdir(home);
  const selected = path.join(home, 'docs');
  await fs.mkdir(selected);
  // /private is forbidden as a real selectable directory on macOS. Inject a stable
  // logical home while keeping all persistence in a disposable physical directory.
  const logicalHome = '/Users/fixture';
  const io = Object.create(fs);
  io.realpath = async (file) => (file === selected ? logicalHome + '/docs' : fs.realpath(file));
  io.stat = async (file) => (file === logicalHome + '/docs' ? fs.stat(selected) : fs.stat(file));
  const file = path.join(base, 'plans.json');
  return {
    file,
    selected,
    io,
    store: new DirectoryStore(file, logicalHome, io, mac(logicalHome)),
    logicalHome,
  };
}
test('plans persist with schema and private permissions; identity is recorded only by the broker', async (t) => {
  const { store, selected, file, logicalHome, io } = await fixture(t);
  await store.load();
  await store.add(selected, 'ro');
  const raw = JSON.parse(await fs.readFile(file));
  assert.equal(raw.schemaVersion, 2);
  assert.equal(raw.directories[0].identity, undefined);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  raw.directories[0].status = 'active';
  await fs.writeFile(file, JSON.stringify(raw));
  const reopened = new DirectoryStore(file, logicalHome, io, mac(logicalHome));
  await reopened.load();
  assert.equal(reopened.directories[0].status, undefined);
  await reopened.recordIdentity(reopened.directories[0].id, ['1', '2']);
  assert.deepEqual(JSON.parse(await fs.readFile(file)).directories[0].identity, ['1', '2']);
  await assert.rejects(
    reopened.recordIdentity(reopened.directories[0].id, ['x', '2']),
    /INVALID_SETTINGS/,
  );
  await assert.rejects(store.add(selected, 'rw'), /DIRECTORY_OVERLAPS/);
});
test('schema v1 and unversioned files load without identity; bad identity is rejected', async (t) => {
  const { file, logicalHome, io } = await fixture(t);
  const entry = {
    id: '11111111-1111-4111-8111-111111111111',
    path: logicalHome + '/docs',
    mode: 'ro',
  };
  for (const value of [
    { directories: [entry] },
    { schemaVersion: 1, directories: [{ ...entry, status: 'pending' }] },
  ]) {
    await fs.writeFile(file, JSON.stringify(value));
    const store = new DirectoryStore(file, logicalHome, io, mac(logicalHome));
    await store.load();
    assert.deepEqual(store.directories, [entry]);
  }
  await fs.writeFile(
    file,
    JSON.stringify({ schemaVersion: 2, directories: [{ ...entry, identity: ['1'] }] }),
  );
  await assert.rejects(
    new DirectoryStore(file, logicalHome, io, mac(logicalHome)).load(),
    /INVALID_SETTINGS/,
  );
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 3, directories: [] }));
  await assert.rejects(
    new DirectoryStore(file, logicalHome, io, mac(logicalHome)).load(),
    /UNSUPPORTED_SETTINGS_VERSION/,
  );
});
test('failed atomic rename leaves disk and memory unchanged', async (t) => {
  const { store, selected, file, io } = await fixture(t);
  await store.add(selected, 'ro');
  const before = await fs.readFile(file, 'utf8');
  io.rename = async () => {
    throw Error('DISK_ERROR');
  };
  await assert.rejects(store.update(store.directories[0].id, 'rw'), /DISK_ERROR/);
  assert.equal(store.directories[0].mode, 'ro');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('unknown schema or invalid JSON is preserved and blocks mutation', async (t) => {
  const { store, file, selected } = await fixture(t);
  await fs.writeFile(file, '{broken');
  await assert.rejects(store.load());
  await assert.rejects(store.add(selected, 'ro'), /SETTINGS_RECOVERY_REQUIRED/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
test('concurrent edits serialize and last committed plan wins', async (t) => {
  const { store, selected } = await fixture(t);
  await store.add(selected, 'ro');
  const id = store.directories[0].id;
  await Promise.all([store.update(id, 'rw'), store.update(id, 'ro')]);
  assert.equal(store.directories[0].mode, 'ro');
});
test('sensitive roots, ancestors and credential stores are rejected per platform', () => {
  const home = '/Users/fixture';
  for (const dir of [
    '/',
    '/Users',
    '/Users/fixture',
    '/Users/fixture/.lima',
    '/Users/fixture/.ssh/sub',
    '/System',
  ]) {
    assert.throws(() => validateDirectory(dir, home, [], mac(home)));
  }
  assert.doesNotThrow(() => validateDirectory('/Users/fixture/docs', home, [], mac(home)));
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/home/fixture' });
  for (const dir of [
    '/proc',
    '/sys/kernel',
    '/root',
    '/home/fixture/.local/share/anchi/tools',
    '/home/fixture/.config',
  ]) {
    assert.throws(() => validateDirectory(dir, '/home/fixture', [], linux));
  }
  assert.doesNotThrow(() => validateDirectory('/home/fixture/docs', '/home/fixture', [], linux));
});
