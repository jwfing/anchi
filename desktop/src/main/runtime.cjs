const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { executable } = require('./host-tools.cjs');

/** Only inherited values required by Lima/SSH; never forward provider credentials. */
function childEnvironment() {
  return {
    HOME: os.homedir(),
    USER: os.userInfo().username,
    LANG: 'en_US.UTF-8',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: os.tmpdir(),
  };
}

async function resolveRuntime({ packaged, resourcesPath }) {
  const root = packaged ? path.join(resourcesPath, 'runtime') : path.resolve(__dirname, '../../..');
  for (const file of ['scripts/pi.sh', 'scripts/policy.sh']) await fs.access(path.join(root, file));
  return root;
}

class Runtime {
  constructor(root) {
    this.root = root;
    this.env = childEnvironment();
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
  async auth(action, value = {}) {
    if (!['status', 'import-client', 'begin', 'complete', 'cancel', 'disconnect'].includes(action))
      throw Error('INVALID_AUTH_ACTION');
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
      ],
      value,
    );
  }

  async lima() {
    const file = await executable('limactl');
    if (!file) throw Error('LIMA_NOT_INSTALLED');
    return file;
  }
  /** Host Python for the file broker: the same interpreter first-run setup installs. */
  async python() {
    const file = await executable('python');
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
