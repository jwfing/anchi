const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

/**
 * The only module that knows what differs between supported hosts. Everything else asks
 * describe() for tool paths, system directories, dependency strategy and the child PATH.
 */
const SECRET_DIRECTORIES = Object.freeze([
  '.ssh',
  '.aws',
  '.kube',
  '.codex',
  '.config',
  '.lima',
  '.hermes',
  '.gnupg',
  'Library',
  '.local/share/anchi',
]);
const SYSTEM_DIRECTORIES = Object.freeze({
  'darwin-arm64': [
    '/',
    '/System',
    '/Library',
    '/etc',
    '/private',
    '/usr',
    '/bin',
    '/sbin',
    '/dev',
    '/var',
  ],
  'linux-x64': [
    '/',
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/root',
    '/run',
    '/sbin',
    '/snap',
    '/srv',
    '/sys',
    '/usr',
    '/var',
  ],
});
/** Root-only steps the app shows verbatim instead of running; the user executes them. */
const MANUAL = Object.freeze({
  qemu: 'sudo apt-get install -y qemu-system-x86 qemu-utils',
  kvm: 'sudo usermod -aG kvm "$USER"',
});

function describe({ platform = process.platform, arch = process.arch, home = os.homedir() } = {}) {
  const id =
    platform === 'darwin' && arch === 'arm64'
      ? 'darwin-arm64'
      : platform === 'linux' && arch === 'x64'
        ? 'linux-x64'
        : null;
  const toolsDirectory = path.join(home, '.local/share/anchi/tools');
  const base = {
    id,
    supported: id !== null,
    home,
    toolsDirectory,
    nvmDirectory: path.join(home, '.nvm/versions/node'),
    secretDirectories: SECRET_DIRECTORIES,
    systemDirectories: SYSTEM_DIRECTORIES[id] || SYSTEM_DIRECTORIES['linux-x64'],
  };
  if (id === 'darwin-arm64')
    return {
      ...base,
      tools: {
        brew: ['/opt/homebrew/bin/brew'],
        python: ['/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3', '/usr/bin/python3'],
        codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
        limactl: ['/opt/homebrew/bin/limactl', '/usr/local/bin/limactl'],
        qemu: [],
      },
      childPath: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      dependencies: { kind: 'brew' },
      kvmDevice: null,
      extraEnvironment: [],
    };
  if (id === 'linux-x64')
    return {
      ...base,
      tools: {
        brew: [],
        python: ['/usr/bin/python3', '/usr/local/bin/python3'],
        codex: [
          path.join(toolsDirectory, 'codex/current/codex'),
          '/usr/local/bin/codex',
          path.join(home, '.npm-global/bin/codex'),
        ],
        limactl: [
          path.join(toolsDirectory, 'lima/current/bin/limactl'),
          '/usr/local/bin/limactl',
          '/usr/bin/limactl',
          '/home/linuxbrew/.linuxbrew/bin/limactl',
        ],
        qemu: ['/usr/bin/qemu-system-x86_64', '/usr/local/bin/qemu-system-x86_64'],
      },
      childPath: [
        path.join(toolsDirectory, 'lima/current/bin'),
        path.join(toolsDirectory, 'codex/current'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(':'),
      dependencies: { kind: 'download', tools: ['lima', 'codex'] },
      kvmDevice: '/dev/kvm',
      extraEnvironment: ['XDG_RUNTIME_DIR'],
    };
  return {
    ...base,
    tools: { brew: [], python: ['/usr/bin/python3'], codex: [], limactl: [], qemu: [] },
    childPath: '/usr/local/bin:/usr/bin:/bin',
    dependencies: { kind: 'none' },
    kvmDevice: null,
    extraEnvironment: [],
  };
}

/** null when the platform has no KVM concept; otherwise whether the device is usable. */
async function kvmAvailable(info, access = fs.access) {
  if (!info.kvmDevice) return null;
  try {
    await access(info.kvmDevice, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function manualSteps(info, health) {
  if (info.id !== 'linux-x64') return [];
  const steps = [];
  if (health.qemu === false) steps.push(MANUAL.qemu);
  if (health.kvm === false) steps.push(MANUAL.kvm);
  return steps;
}

module.exports = { describe, kvmAvailable, manualSteps, SYSTEM_DIRECTORIES, SECRET_DIRECTORIES };
