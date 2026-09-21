const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { LIMITS } = require('../src/shared/protocol.cjs');
const root = path.resolve(__dirname, '../..');
test('wire limits are identical across desktop, Pi cell code and trusted services', async () => {
  const pi = (await import(pathToFileURL(path.join(root, 'pi/limits.mjs')))).LIMITS;
  assert.deepEqual({ ...pi }, { ...LIMITS });
  const python = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, json, sys',
        "sys.path.insert(0, 'services')",
        'import common',
        "spec = importlib.util.spec_from_file_location('host_files', 'scripts/host-files.py')",
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        "print(json.dumps({'limits': common.LIMITS, 'host_file': module.LIMIT, 'pi_version': common.PI_VERSION}))",
      ].join('\n'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(python.status, 0, python.stderr);
  const value = JSON.parse(python.stdout);
  assert.deepEqual(value.limits, { ...LIMITS });
  assert.equal(value.host_file, LIMITS.host_file_text_bytes);
  const pkg = require(path.join(root, 'pi/package.json'));
  assert.equal(value.pi_version, pkg.dependencies['@earendil-works/pi-coding-agent']);
});
