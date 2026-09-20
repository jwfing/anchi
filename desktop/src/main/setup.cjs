const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const REMEDIATION = {
  dependencies: '安装失败。请检查网络及 Homebrew 的系统安装提示，然后重试。',
  install: '安装未完成。检查网络和可用磁盘后重试；已有凭证和工作区会保留。',
  unlock: '解锁失败。已有加密凭证时必须使用原来的主密钥，不能生成替代密钥。',
  login: '登录未完成或已过期，请重新登录；浏览器授权需由你完成。',
  import: '未找到可用的 Codex 订阅登录，或令牌即将到期。请点击登录后再导入。',
};
class Setup {
  constructor({ runtime, notify, userData, spawnProcess = spawn }) {
    Object.assign(this, { runtime, notify, userData, spawnProcess });
    this.job = null;
    this.active = false;
    this.child = null;
    this.health = null;
    this.completedAt = null;
  }
  async load() {
    try {
      const file = path.join(this.userData, 'setup-job.json');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
      const job = JSON.parse(await fs.readFile(file, 'utf8'));
      if (
        Object.hasOwn(REMEDIATION, job.action) &&
        ['running', 'failed', 'succeeded'].includes(job.state)
      ) {
        this.job = {
          action: job.action,
          state: job.state === 'running' ? 'failed' : job.state,
          message:
            job.state === 'running'
              ? '上次设置被中断。请重新检查并重试相应步骤；不会自动删除已有数据。'
              : job.state === 'succeeded'
                ? '上次设置步骤已完成。'
                : REMEDIATION[job.action],
        };
      }
    } catch {}
    try {
      const value = JSON.parse(
        await fs.readFile(path.join(this.userData, 'first-task.json'), 'utf8'),
      );
      if (typeof value.completedAt === 'string' && !Number.isNaN(Date.parse(value.completedAt)))
        this.completedAt = value.completedAt;
    } catch {}
  }
  async save(file, value) {
    await fs.mkdir(this.userData, { recursive: true, mode: 0o700 });
    const target = path.join(this.userData, file);
    const temp = target + '.tmp';
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'w' });
    await fs.rename(temp, target);
  }
  async completed() {
    this.completedAt = new Date().toISOString();
    await this.save('first-task.json', { completedAt: this.completedAt });
  }
  get busy() {
    return this.active;
  }
  async executable(name) {
    const paths = {
      brew: ['/opt/homebrew/bin/brew'],
      python: ['/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3', '/usr/bin/python3'],
      codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
    };
    if (name === 'codex') {
      const base = path.join(os.homedir(), '.nvm/versions/node');
      const versions = await fs.readdir(base).catch(() => []);
      paths.codex.push(
        ...versions
          .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
          .sort()
          .reverse()
          .map((v) => path.join(base, v, 'bin/codex')),
      );
    }
    for (const file of paths[name] || []) {
      try {
        await fs.access(file, fs.constants.X_OK);
        return file;
      } catch {}
    }
    return null;
  }
  async inspect() {
    const [brew, python, codex, lima] = await Promise.all([
      this.executable('brew'),
      this.executable('python'),
      this.executable('codex'),
      this.runtime.lima().catch(() => null),
    ]);
    const health = {
      supported: process.platform === 'darwin' && process.arch === 'arm64',
      brew: !!brew,
      python: !!python,
      codex: !!codex,
      lima: !!lima,
      vm: 'missing',
      freeGiB: Math.floor(
        await fs
          .statfs(os.homedir())
          .then((s) => (s.bavail * s.bsize) / 1024 ** 3)
          .catch(() => 0),
      ),
      installed: false,
      unlocked: false,
      configured: false,
    };
    if (lima) {
      try {
        const info = await this.runtime.inspect();
        const vm = info.instances.find((v) => v.name === 'secure-vm');
        health.vm = vm?.status || 'missing';
        if (vm?.status === 'Running') {
          try {
            Object.assign(
              health,
              await this.runtime.input(
                lima,
                [
                  'shell',
                  'secure-vm',
                  '--',
                  'sudo',
                  '/usr/bin/python3',
                  '/opt/secure-vm/services/setup_status.py',
                ],
                {},
              ),
            );
          } catch {
            health.probeError = true;
          }
        }
      } catch {
        health.vm = 'unknown';
      }
    }
    this.health = health;
    return { health, job: this.job };
  }
  run(file, args, timeout = 30 * 60 * 1000) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(file, args, {
        cwd: this.runtime.root,
        env: { ...this.runtime.env, PATH: path.dirname(file) + ':' + this.runtime.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      this.child = child;
      // Never forward installer/auth stdout: it may contain URLs, codes or tokens.
      child.stdout.resume();
      child.stderr.resume();
      const stop = (signal) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch {}
      };
      this.stopChild = stop;
      const timer = setTimeout(() => stop('SIGTERM'), timeout);
      const kill = setTimeout(() => stop('SIGKILL'), timeout + 5000);
      child.once('error', () => {
        clearTimeout(timer);
        clearTimeout(kill);
        this.child = null;
        reject(Error('SETUP_PROCESS_FAILED'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        clearTimeout(kill);
        this.child = null;
        code === 0 ? resolve() : reject(Error('SETUP_PROCESS_FAILED'));
      });
    });
  }
  async start(action) {
    if (!Object.hasOwn(REMEDIATION, action)) throw Error('INVALID_SETUP_ACTION');
    if (this.busy) throw Error('SETUP_IN_PROGRESS');
    const health = (await this.inspect()).health;
    if (this.busy) throw Error('SETUP_IN_PROGRESS');
    if (!health.supported) throw Error('MAC_ARM64_REQUIRED');
    if (action === 'install' && health.freeGiB < 8) throw Error('DISK_SPACE_REQUIRED');
    if (action === 'dependencies' && !health.brew) throw Error('HOMEBREW_REQUIRED');
    if (action !== 'dependencies' && (!health.lima || !health.python))
      throw Error('INSTALL_DEPENDENCIES_FIRST');
    if (['unlock', 'login', 'import'].includes(action) && !health.installed)
      throw Error('INSTALL_PI_FIRST');
    if (['login', 'import'].includes(action) && !health.unlocked) throw Error('UNLOCK_VAULT_FIRST');
    this.active = true;
    this.stopChild = null;
    this.loginCancelled = false;
    this.job = {
      phase: action === 'login' ? 'browser' : action,
      action,
      state: 'running',
      startedAt: new Date().toISOString(),
      message: '处理中，请保持应用打开。',
    };
    await this.save('setup-job.json', this.job).catch(() => {
      this.active = false;
      this.job.state = 'failed';
      throw Error('SETUP_STATE_UNWRITABLE');
    });
    this.publish();
    this.work = (async () => {
      let success = false;
      try {
        await this.execute(action);
        success = true;
      } catch {}
      await this.inspect().catch(() => {});
      this.job = {
        ...this.job,
        state: success ? 'succeeded' : 'failed',
        message: success ? '此步骤已完成，可以继续下一步。' : REMEDIATION[action],
      };
      await this.save('setup-job.json', this.job).catch(() => {});
      this.active = false;
      this.publish();
    })();
    return { job: this.job, health: this.health };
  }
  publish() {
    this.notify({ type: 'setup_changed', job: this.job });
  }
  async execute(action) {
    if (action === 'dependencies') {
      const brew = await this.executable('brew');
      await this.run(brew, ['install', 'lima', 'python@3.13']);
      if (!(await this.executable('codex'))) await this.run(brew, ['install', '--cask', 'codex']);
    } else if (action === 'install') {
      await this.run(
        '/bin/bash',
        [path.join(this.runtime.root, 'scripts/install-pi.sh')],
        60 * 60 * 1000,
      );
    } else if (action === 'unlock') {
      await this.run(await this.executable('python'), [
        path.join(this.runtime.root, 'scripts/vault.py'),
        'init',
      ]);
    } else {
      if (action === 'login') {
        const codex = await this.executable('codex');
        if (!codex) throw Error('CODEX_NOT_INSTALLED');
        await this.run(codex, ['-c', 'cli_auth_credentials_store="file"', 'login'], 10 * 60 * 1000);
        if (this.loginCancelled) throw Error('LOGIN_CANCELLED');
        this.job.phase = 'import';
        this.job.message = '登录完成，正在将短期访问令牌导入隔离认证层。';
        this.publish();
      }
      await this.run(await this.executable('python'), [
        path.join(this.runtime.root, 'scripts/pi-auth.py'),
      ]);
    }
    if (['install', 'unlock', 'login', 'import'].includes(action)) {
      const health = (await this.inspect()).health;
      if (
        !health.installed ||
        (action === 'unlock' && !health.unlocked) ||
        (['login', 'import'].includes(action) && !health.configured)
      )
        throw Error('SETUP_VERIFY_FAILED');
    }
  }
  cancelLogin() {
    if (this.job?.action !== 'login' || this.job.phase !== 'browser' || !this.busy)
      throw Error('NO_LOGIN_IN_PROGRESS');
    this.loginCancelled = true;
    this.stopChild?.('SIGTERM');
  }
}
module.exports = { Setup };
