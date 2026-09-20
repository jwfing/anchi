const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { bundleRuntime } = require('../scripts/runtime-bundle.cjs');
const { resolveRuntime } = require('../src/main/runtime.cjs');
test('release runtime is self-contained, hashed and excludes credential files', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'qisuo-bundle-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.resolve(__dirname, '../..'),
    dest = path.join(base, 'runtime');
  const manifest = await bundleRuntime(root, dest, 'test');
  assert(manifest.files.some((f) => f.path === 'scripts/pi.sh'));
  assert(
    !manifest.files.some((f) => /node_modules|token\.json|client_secret|auth\.json/.test(f.path)),
  );
  for (const file of manifest.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await resolveRuntime({ packaged: true, resourcesPath: base }), dest);
  assert.equal(await resolveRuntime({ packaged: false }), root);
});
