const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Setup } = require('../src/main/setup.cjs');
async function fixture(t) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-setup-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const events = [];
  const setup = new Setup({
    runtime: { root: '/runtime', env: {} },
    userData,
    notify: (e) => events.push(e),
  });
  const health = {
    supported: true,
    brew: true,
    lima: true,
    python: true,
    codex: true,
    freeGiB: 20,
    installed: false,
    unlocked: false,
    configured: false,
  };
  setup.inspect = async () => {
    setup.health = { ...health };
    return { health: setup.health, job: setup.job };
  };
  setup.executable = async (name) => '/trusted/' + name;
  return { setup, health, events, userData };
}
test('fresh installation, unlock, subscription import verify each stage', async (t) => {
  const { setup, health } = await fixture(t);
  const calls = [];
  setup.run = async (file, args) => {
    calls.push([file, args]);
    if (args[0].endsWith('install-pi.sh')) health.installed = true;
    if (args[0].endsWith('vault.py')) health.unlocked = true;
    if (args[0].endsWith('pi-auth.py')) health.configured = true;
  };
  await assert.rejects(setup.start('import'), /INSTALL_PI_FIRST/);
  for (const action of ['install', 'unlock', 'import']) {
    assert.equal((await setup.start(action)).job.state, 'running');
    await setup.work;
    assert.equal(setup.job.state, 'succeeded');
  }
  assert.equal(health.configured, true);
  assert.equal(calls.length, 3);
  assert(!JSON.stringify(calls).includes('access_token'));
});
test('failed install retries, but cannot report success without readiness', async (t) => {
  const { setup, health } = await fixture(t);
  let count = 0;
  setup.run = async () => {
    if (++count === 1) throw Error('SENSITIVE_OUTPUT');
    health.installed = true;
  };
  await setup.start('install');
  await setup.work;
  assert.equal(setup.job.state, 'failed');
  assert(!setup.job.message.includes('SENSITIVE'));
  await setup.start('install');
  await setup.work;
  assert.equal(setup.job.state, 'succeeded');
  health.configured = false;
  await setup.start('unlock');
  await setup.work;
  assert.equal(setup.job.state, 'failed');
});
test('concurrent actions, missing dependencies and low disk fail closed', async (t) => {
  const { setup, health } = await fixture(t);
  let finish;
  setup.execute = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  health.freeGiB = 3;
  await assert.rejects(setup.start('install'), /DISK_SPACE/);
  health.freeGiB = 20;
  health.lima = false;
  await assert.rejects(setup.start('install'), /DEPENDENCIES/);
  health.lima = true;
  await setup.start('install');
  await assert.rejects(setup.start('unlock'), /SETUP_IN_PROGRESS/);
  finish();
  await setup.work;
  await assert.rejects(setup.start('arbitrary-command'), /INVALID_SETUP_ACTION/);
});
test('interrupted setup survives restart as retryable, never auto executes', async (t) => {
  const { setup, userData } = await fixture(t);
  await setup.save('setup-job.json', { action: 'install', state: 'running' });
  await setup.load();
  assert.equal(setup.job.state, 'failed');
  assert.match(setup.job.message, /中断/);
  await setup.completed();
  const second = new Setup({ runtime: {}, userData, notify() {} });
  await second.load();
  assert.equal(second.completedAt, setup.completedAt);
});

test('cancelling browser login cannot continue into credential import', async (t) => {
  const { setup, health } = await fixture(t);
  health.installed = true;
  health.unlocked = true;
  const calls = [];
  let finish;
  setup.run = async (file, args) => {
    calls.push(args);
    await new Promise((resolve) => {
      finish = resolve;
    });
  };
  await setup.start('login');
  await new Promise((resolve) => setImmediate(resolve));
  setup.cancelLogin();
  finish();
  await setup.work;
  assert.equal(setup.job.state, 'failed');
  assert.equal(calls.length, 1);
  assert(calls[0].includes('login'));
});
