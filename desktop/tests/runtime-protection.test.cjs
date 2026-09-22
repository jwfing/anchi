const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('../src/main/runtime.cjs');
const { describe } = require('../src/main/platform.cjs');
const { validateProtectedDirectory } = require('../src/main/directory-store.cjs');

test('runtime protection includes real tool installations behind executable symlinks', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-runtime-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = await fs.realpath(temp);
  const bin = path.join(root, 'python-install/bin');
  await fs.mkdir(bin, { recursive: true });
  const python = path.join(bin, 'python3');
  await fs.writeFile(python, '', { mode: 0o700 });
  const alias = path.join(root, 'python-alias');
  await fs.symlink(python, alias);
  const runtimeRoot = path.join(root, 'runtime');
  await fs.mkdir(runtimeRoot);
  const platform = {
    ...describe({ platform: 'linux', arch: 'x64', home: root }),
    tools: { python: [alias] },
    toolsDirectory: path.join(root, 'python-install'),
  };
  const paths = await new Runtime(runtimeRoot, platform).protectedPaths();
  assert(paths.includes(runtimeRoot));
  assert(paths.includes(path.join(root, 'python-install')));
  assert.throws(
    () => validateProtectedDirectory(path.join(root, 'python-install/lib'), 'rw', paths),
    /RUNTIME_DIRECTORY_NOT_ALLOWED/,
  );
  assert.throws(
    () => validateProtectedDirectory(root, 'rw', paths),
    /RUNTIME_DIRECTORY_NOT_ALLOWED/,
  );
});

test('a standalone home/bin tool does not protect all home and missing paths do not break startup', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-home-bin-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const home = await fs.realpath(temp);
  await fs.mkdir(path.join(home, 'bin'));
  const tool = path.join(home, 'bin/codex');
  await fs.writeFile(tool, '', { mode: 0o700 });
  const platform = {
    ...describe({ platform: 'linux', arch: 'x64', home }),
    tools: { codex: [tool] },
  };
  const paths = await new Runtime(path.join(home, 'missing-runtime'), platform).protectedPaths();
  assert(!paths.includes(home));
  validateProtectedDirectory(path.join(home, 'Documents'), 'rw', paths);
  assert.throws(
    () => validateProtectedDirectory(path.join(home, 'bin'), 'rw', paths),
    /RUNTIME_DIRECTORY_NOT_ALLOWED/,
  );
});
