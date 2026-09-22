const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Runtime } = require('../src/main/runtime.cjs');
const { describe } = require('../src/main/platform.cjs');

const platform = (limactl) => ({
  ...describe({ platform: 'linux', arch: 'x64', home: '/nonexistent', exists: () => false }),
  tools: { limactl },
});

test('policy reports a missing Lima as itself instead of a shell failure', async () => {
  const runtime = new Runtime('/nonexistent/runtime', platform([]));
  runtime.command = async () => assert.fail('policy.sh must not run without limactl');
  await assert.rejects(() => runtime.policy('rules'), /LIMA_NOT_INSTALLED/);
});

test('policy passes the operation to policy.sh once Lima resolves', async () => {
  const runtime = new Runtime('/runtime', platform(['/bin/sh']));
  let seen = null;
  runtime.command = async (file, args) => {
    seen = { file, args };
    return '{"rules": []}';
  };
  assert.deepEqual(await runtime.policy('rules'), { rules: [] });
  assert.equal(seen.file, '/bin/bash');
  assert.deepEqual(seen.args, ['/runtime/scripts/policy.sh', 'rules']);
});
