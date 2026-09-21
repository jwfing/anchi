const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executable } = require('../src/main/host-tools.cjs');
const { describe } = require('../src/main/platform.cjs');

test('executables resolve only from the platform table, in order', async () => {
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/home/x' });
  const present = new Set([
    '/usr/bin/limactl',
    '/home/x/.local/share/anchi/tools/codex/current/codex',
  ]);
  const access = async (file) => {
    if (!present.has(file)) throw Error('ENOENT');
  };
  assert.equal(await executable('limactl', { access, platform: linux }), '/usr/bin/limactl');
  assert.equal(
    await executable('codex', { access, readdir: async () => [], platform: linux }),
    '/home/x/.local/share/anchi/tools/codex/current/codex',
  );
  assert.equal(await executable('brew', { access, platform: linux }), null);
  assert.equal(await executable('qemu', { access, platform: linux }), null);
  const mac = describe({ platform: 'darwin', arch: 'arm64', home: '/Users/x' });
  assert.equal(
    await executable('limactl', { access: async () => {}, platform: mac }),
    '/opt/homebrew/bin/limactl',
  );
  // nvm-installed codex is discovered from the platform's nvm directory, newest first.
  assert.equal(
    await executable('codex', {
      access: async (file) => {
        if (!file.startsWith('/Users/x/.nvm/')) throw Error('ENOENT');
      },
      readdir: async () => ['v20.1.0', 'v22.3.1', 'junk'],
      platform: mac,
    }),
    '/Users/x/.nvm/versions/node/v22.3.1/bin/codex',
  );
});
