const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { executable } = require('./host-tools.cjs');
const { describe } = require('./platform.cjs');
const { isConnector } = require('../shared/connectors.cjs');

/** Only inherited values required by Lima/SSH; never forward provider credentials. */
function childEnvironment(platform = describe()) {
  const env = {
    HOME: platform.home,
    USER: os.userInfo().username,
    LANG: 'en_US.UTF-8',
    PATH: platform.childPath,
    TMPDIR: os.tmpdir(),
  };
  for (const name of platform.extraEnvironment)
    if (process.env[name]) env[name] = process.env[name];
  return env;
}

async function resolveRuntime({ packaged, resourcesPath }) {
  const root = packaged ? path.join(resourcesPath, 'runtime') : path.resolve(__dirname, '../../..');
  for (const file of ['scripts/pi.sh', 'scripts/policy.sh']) await fs.access(path.join(root, file));
  return root;
}

class Runtime {
  constructor(root, platform = describe()) {
    this.root = root;
    this.platform = platform;
    this.env = childEnvironment(platform);
  }

  async protectedPaths(extra = []) {
    const paths = [this.root, process.execPath, ...extra];
    for (const name of ['python', 'limactl', 'codex', 'brew', 'qemu']) {
      const file = await executable(name, { platform: this.platform });
      if (file) {
        paths.push(file, path.dirname(path.dirname(await fs.realpath(file))));
      }
    }
    return [...new Set(await Promise.all(paths.map(async (p) => fs.realpath(p))))];
  }

  async command(file, args, timeout = 30000) {
    const { stdout } = await exec(file, args, {
      cwd: this.root,
      env: this.env,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }

  async input(file, args, value) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        { cwd: this.root, env: this.env, timeout: 25000, maxBuffer: 262144 },
        (error, stdout) => {
          let result;
          try {
            result = JSON.parse(stdout);
          } catch {
            reject(Error('TRUSTED_HELPER_FAILED'));
            return;
          }
          if (error || result.error)
            reject(Error(/^[A-Z_]+$/.test(result.error) ? result.error : 'TRUSTED_HELPER_FAILED'));
          else resolve(result);
        },
      );
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(value));
    });
  }
  async auth(action, value = {}, connector = 'gmail') {
    const actions = [
      'status',
      'import-client',
      'begin',
      'complete',
      'cancel',
      'disconnect',
      'import-token',
      'set-account',
    ];
    if (!actions.includes(action)) throw Error('INVALID_AUTH_ACTION');
    if (!isConnector(connector)) throw Error('INVALID_CONNECTOR');
    return this.input(
      await this.lima(),
      [
        'shell',
        'secure-vm',
        '--',
        'sudo',
        '/usr/bin/python3',
        '/opt/secure-vm/services/admin.py',
        action,
        connector,
      ],
      value,
    );
  }
  /** Probe the provider as the connector's own identity, or disconnect it; root entry in the guest. */
  async connectorAdmin(connector, action) {
    if (!isConnector(connector) || !['probe', 'disconnect'].includes(action))
      throw Error('INVALID_CONNECTOR_ACTION');
    return this.input(
      await this.lima(),
      [
        'shell',
        'secure-vm',
        '--',
        'sudo',
        '/usr/bin/python3',
        '/opt/secure-vm/services/connector_admin.py',
        connector,
        action,
      ],
      {},
    );
  }

  async lima() {
    const file = await executable('limactl', { platform: this.platform });
    if (!file) throw Error('LIMA_NOT_INSTALLED');
    return file;
  }
  /** Host Python for the file broker: the same interpreter first-run setup installs. */
  async python() {
    const file = await executable('python', { platform: this.platform });
    if (!file) throw Error('PYTHON_NOT_INSTALLED');
    return file;
  }

  async inspect() {
    const text = await this.command(await this.lima(), ['list', 'secure-vm', '--json'], 15000);
    return {
      instances: text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  }

  async start() {
    await this.command(await this.lima(), ['start', 'secure-vm', '--tty=false'], 120000);
  }

  async policy(op, ...args) {
    return JSON.parse(
      await this.command('/bin/bash', [path.join(this.root, 'scripts/policy.sh'), op, ...args]),
    );
  }
}

module.exports = { Runtime, resolveRuntime, childEnvironment };
