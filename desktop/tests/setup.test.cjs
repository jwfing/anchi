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

test('Linux refuses to build the VM until qemu and kvm are present, and downloads instead of brewing', async (t) => {
  const { describe } = require('../src/main/platform.cjs');
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/home/x' });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-setup-linux-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const installed = [];
  const setup = new Setup({
    runtime: { root: '/runtime', env: {} },
    userData,
    notify() {},
    platform: linux,
    install: async (name, entry, options) => {
      installed.push([name, entry.version, options.toolsDirectory]);
      return '/tools/' + name;
    },
  });
  const health = {
    supported: true,
    platform: 'linux-x64',
    brew: false,
    lima: false,
    python: true,
    codex: false,
    qemu: false,
    kvm: false,
    freeGiB: 20,
    installed: false,
    unlocked: false,
    configured: false,
    manualSteps: [
      'sudo apt-get install -y qemu-system-x86 qemu-utils',
      'sudo usermod -aG kvm "$USER"',
    ],
  };
  setup.inspect = async () => {
    setup.health = { ...health };
    return { health: setup.health, job: setup.job };
  };
  setup.executable = async (name) => (name === 'python' ? '/usr/bin/python3' : null);
  setup.run = async () => {
    throw Error('BREW_MUST_NOT_RUN');
  };
  await assert.rejects(setup.start('install'), /INSTALL_DEPENDENCIES_FIRST/);
  await setup.start('dependencies');
  await setup.work;
  assert.equal(setup.job.state, 'succeeded');
  assert.deepEqual(installed, [
    ['lima', '2.2.0', '/home/x/.local/share/anchi/tools'],
    ['codex', 'rust-v0.155.1', '/home/x/.local/share/anchi/tools'],
  ]);
  health.lima = true;
  health.codex = true;
  await assert.rejects(setup.start('install'), /INSTALL_DEPENDENCIES_FIRST/);
  health.qemu = true;
  await assert.rejects(setup.start('install'), /INSTALL_DEPENDENCIES_FIRST/);
  health.kvm = true;
  setup.execute = async () => {};
  await setup.start('install');
  await setup.work;
  assert.equal(setup.job.state, 'succeeded');
});

test('already present tools are not downloaded again', async (t) => {
  const { describe } = require('../src/main/platform.cjs');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-setup-linux2-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const installed = [];
  const setup = new Setup({
    runtime: { root: '/runtime', env: {} },
    userData,
    notify() {},
    platform: describe({ platform: 'linux', arch: 'x64', home: '/home/x' }),
    install: async (name) => installed.push(name),
  });
  setup.inspect = async () => {
    setup.health = { supported: true, platform: 'linux-x64', freeGiB: 20 };
    return { health: setup.health, job: setup.job };
  };
  setup.executable = async (name) => (name === 'limactl' ? '/usr/bin/limactl' : null);
  await setup.start('dependencies');
  await setup.work;
  assert.deepEqual(installed, ['codex']);
});

test('unsupported hosts fail closed with a platform error', async (t) => {
  const { describe } = require('../src/main/platform.cjs');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-setup-unsupported-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const setup = new Setup({
    runtime: { root: '/runtime', env: {} },
    userData,
    notify() {},
    platform: describe({ platform: 'win32', arch: 'x64', home: '/h' }),
  });
  setup.inspect = async () => {
    setup.health = { supported: false };
    return { health: setup.health, job: null };
  };
  await assert.rejects(setup.start('dependencies'), /PLATFORM_UNSUPPORTED/);
});
