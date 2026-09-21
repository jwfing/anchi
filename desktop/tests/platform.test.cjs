const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describe, kvmAvailable, manualSteps } = require('../src/main/platform.cjs');

test('macOS arm64 keeps Homebrew paths and brew-based dependencies', () => {
  const info = describe({ platform: 'darwin', arch: 'arm64', home: '/Users/x' });
  assert.equal(info.id, 'darwin-arm64');
  assert.equal(info.supported, true);
  assert.deepEqual(info.tools.brew, ['/opt/homebrew/bin/brew']);
  assert.equal(info.dependencies.kind, 'brew');
  assert.equal(info.kvmDevice, null);
  assert(info.childPath.startsWith('/opt/homebrew/bin:'));
  assert(info.systemDirectories.includes('/System'));
});

test('Linux x64 downloads tools into the user directory and never uses brew', () => {
  const info = describe({ platform: 'linux', arch: 'x64', home: '/home/x' });
  assert.equal(info.id, 'linux-x64');
  assert.deepEqual(info.tools.brew, []);
  assert.equal(info.tools.limactl[0], '/home/x/.local/share/anchi/tools/lima/current/bin/limactl');
  assert.equal(info.tools.codex[0], '/home/x/.local/share/anchi/tools/codex/current/codex');
  assert.deepEqual(info.dependencies, { kind: 'download', tools: ['lima', 'codex'] });
  assert.equal(info.kvmDevice, '/dev/kvm');
  assert(info.childPath.startsWith('/home/x/.local/share/anchi/tools/lima/current/bin:'));
  assert(!info.childPath.includes('homebrew'));
  for (const dir of ['/proc', '/sys', '/boot', '/root', '/run'])
    assert(info.systemDirectories.includes(dir));
  assert(info.secretDirectories.includes('.local/share/anchi'));
});

test('other platforms are unsupported but still describable', () => {
  for (const [platform, arch] of [
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
  ]) {
    const info = describe({ platform, arch, home: '/h' });
    assert.equal(info.id, null);
    assert.equal(info.supported, false);
    assert.equal(info.dependencies.kind, 'none');
  }
});

test('kvm availability is null on macOS and follows /dev/kvm access on Linux', async () => {
  assert.equal(
    await kvmAvailable(describe({ platform: 'darwin', arch: 'arm64', home: '/h' })),
    null,
  );
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/h' });
  assert.equal(await kvmAvailable(linux, async () => {}), true);
  assert.equal(
    await kvmAvailable(linux, async () => {
      throw Error('EACCES');
    }),
    false,
  );
});

test('manual steps name exactly the root actions the app refuses to run', () => {
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/h' });
  assert.deepEqual(manualSteps(linux, { qemu: true, kvm: true }), []);
  const steps = manualSteps(linux, { qemu: false, kvm: false });
  assert.equal(steps.length, 2);
  assert.match(steps[0], /apt-get install -y qemu-system-x86 qemu-utils/);
  assert.match(steps[1], /usermod -aG kvm/);
  assert.equal(manualSteps(linux, { qemu: true, kvm: false }).length, 1);
  assert.deepEqual(
    manualSteps(describe({ platform: 'darwin', arch: 'arm64', home: '/h' }), {
      qemu: null,
      kvm: null,
    }),
    [],
  );
});
