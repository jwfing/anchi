const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { bundleRuntime } = require('../scripts/runtime-bundle.cjs');
const { resolveRuntime } = require('../src/main/runtime.cjs');
test('release runtime is self-contained, hashed and excludes credential files', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-bundle-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '../..'),
    dest = path.join(base, 'runtime');
  const manifest = await bundleRuntime(root, dest, 'test');
  assert(manifest.files.some((f) => f.path === 'scripts/pi.sh'));
  assert(manifest.files.some((f) => f.path === 'guest/cell.env'));
  assert(manifest.files.some((f) => f.path === 'pi/version.mjs'));
  assert(
    !manifest.files.some((f) => /node_modules|token\.json|client_secret|auth\.json/.test(f.path)),
  );
  for (const file of manifest.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await resolveRuntime({ packaged: true, resourcesPath: base }), dest);
  assert.equal(await resolveRuntime({ packaged: false }), root);
});
test('packaging targets follow the host platform and refuse others', () => {
  const { targetFor } = require('../scripts/package-target.cjs');
  const { describe } = require('../src/main/platform.cjs');
  assert.deepEqual(targetFor(describe({ platform: 'darwin', arch: 'arm64', home: '/h' })), {
    platform: 'darwin',
    arch: 'arm64',
    directory: 'Anchi-darwin-arm64',
    archive: 'Anchi-mac-arm64.zip',
  });
  assert.deepEqual(targetFor(describe({ platform: 'linux', arch: 'x64', home: '/h' })), {
    platform: 'linux',
    arch: 'x64',
    directory: 'Anchi-linux-x64',
    archive: 'Anchi-linux-x64.tar.gz',
  });
  assert.equal(targetFor(describe({ platform: 'win32', arch: 'x64', home: '/h' })), null);
});
