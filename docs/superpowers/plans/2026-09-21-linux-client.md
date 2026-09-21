# Linux 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Anchi 桌面在 x86_64 Linux 上以 Lima + QEMU/KVM 完成与 macOS 相同的闭环，并由 GitHub Actions 在 KVM runner 上做真机验证。

**Architecture:** 单一 Lima 模板列出双架构镜像，`scripts/up.sh` 按宿主显式传 `--vm-type`；guest 脚本用 `guest/arch.sh` 按 `uname -m` 选 Node 包。桌面新增 `platform.cjs` 集中全部平台差异（工具路径、系统目录、依赖策略、子进程 PATH），`downloader.cjs` 按 `host-tools.json` 的固定版本与 SHA-256 下载 Lima 与 Codex 到用户目录，`setup.cjs`、`runtime.cjs`、`host-tools.cjs`、`directory-store.cjs`、`package.cjs` 只通过 platform 取值。

**Tech Stack:** Electron 44 主进程（CommonJS）、Node 22 `fetch`/`stream`、Bash、Python 3.11+ 标准库、Lima 2.2.0、QEMU、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-20-linux-client-design.md`

## Global Constraints

- 支持矩阵只有 `darwin-arm64` 与 `linux-x64`；其他平台 `supported=false`。
- 应用在任何平台都不请求管理员密码；Linux 需要 root 的步骤只以命令文本展示。
- 下载只接受 `https:`，主机白名单 `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`，最多 3 次重定向，单文件上限 300 MB，SHA-256 不匹配不落盘任何可执行内容。
- 固定版本：Lima `2.2.0`（Linux-x86_64 SHA `a0ea1ccf6b7335a900adb5f8d2b8384457965fecb1ba72f09b4e3e46d12f424a`）；Codex `rust-v0.155.1`（linux musl SHA `a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115`）；Node `22.23.2` x64 SHA `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`；Ubuntu amd64 镜像 `sha256:ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6`。
- 宿主工具目录 `~/.local/share/anchi/tools/<name>/<version>`，`current` 符号链接原子切换。
- 所有改动通过 `make check PYTHON=.venv/bin/python`（Ruff、shellcheck、Prettier、三套单测）。
- 每个任务结束提交一次，提交信息首行为祈使句，结尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

### Task 1: guest 架构映射与双 SHA

**Files:**
- Create: `guest/arch.sh`
- Modify: `guest/cell.env`、`guest/install-pi.sh`、`scripts/install-pi.sh`、`scripts/up.sh`（复制列表）
- Test: `tests/test_constants.py`

**Interfaces:**
- Produces: `node_arch <uname -m>` → `arm64|x64`；`node_sha256 <node_arch>` → 读取 `SECURE_NODE_SHA256_ARM64|X64`；`host_vm_type <uname -s>` → `vz|qemu`。Task 2 的 `up.sh` 依赖 `host_vm_type`。

- [x] **Step 1: 写失败测试**

在 `tests/test_constants.py` 的 `CellEnvTests` 中新增：

```python
    def test_node_sha_per_architecture(self):
        values = common.load_cell_env([ROOT / 'guest/cell.env'])
        self.assertNotIn('SECURE_NODE_SHA256', values)
        for key in ('SECURE_NODE_SHA256_ARM64', 'SECURE_NODE_SHA256_X64'):
            self.assertRegex(values[key], '^[a-f0-9]{64}$')
        self.assertNotEqual(values['SECURE_NODE_SHA256_ARM64'], values['SECURE_NODE_SHA256_X64'])

    def test_arch_helpers(self):
        def run(function, argument):
            return subprocess.run(
                ['bash', '-c', f'set -e; source guest/cell.env; source guest/arch.sh; {function} {argument}'],
                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(run('node_arch', 'aarch64').stdout.strip(), 'arm64')
        self.assertEqual(run('node_arch', 'x86_64').stdout.strip(), 'x64')
        self.assertNotEqual(run('node_arch', 'riscv64').returncode, 0)
        values = common.load_cell_env([ROOT / 'guest/cell.env'])
        self.assertEqual(run('node_sha256', 'x64').stdout.strip(), values['SECURE_NODE_SHA256_X64'])
        self.assertEqual(run('host_vm_type', 'Darwin').stdout.strip(), 'vz')
        self.assertEqual(run('host_vm_type', 'Linux').stdout.strip(), 'qemu')
        self.assertNotEqual(run('host_vm_type', 'Windows_NT').returncode, 0)
```

并在文件顶部 `import subprocess`。

- [x] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m unittest tests.test_constants -v`
Expected: `test_node_sha_per_architecture` 因 `KeyError: 'SECURE_NODE_SHA256_ARM64'` 失败；`test_arch_helpers` 因 `guest/arch.sh` 不存在失败。

- [x] **Step 3: 实现**

`guest/cell.env` 把 `SECURE_NODE_SHA256=...` 一行替换为：

```
SECURE_NODE_SHA256_ARM64=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
SECURE_NODE_SHA256_X64=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
```

新建 `guest/arch.sh`：

```bash
#!/bin/bash
# Architecture and host mapping shared by guest installers and host scripts. Source it; do not execute.
node_arch() {
  case "$1" in
    aarch64 | arm64) echo arm64 ;;
    x86_64 | amd64) echo x64 ;;
    *) echo "Unsupported guest architecture: $1" >&2; return 1 ;;
  esac
}
node_sha256() {
  case "$1" in
    arm64) echo "$SECURE_NODE_SHA256_ARM64" ;;
    x64) echo "$SECURE_NODE_SHA256_X64" ;;
    *) return 1 ;;
  esac
}
host_vm_type() {
  case "$1" in
    Darwin) echo vz ;;
    Linux) echo qemu ;;
    *) echo "Unsupported host OS: $1" >&2; return 1 ;;
  esac
}
```

`guest/install-pi.sh` 开头改为：

```bash
source "$src/cell.env"
# shellcheck source=guest/arch.sh
source "$src/arch.sh"
node_arch=$(node_arch "$(uname -m)")
node_version=$SECURE_NODE_VERSION
node_sha=$(node_sha256 "$node_arch")
node_dir=/opt/secure-vm/node-v${node_version}-linux-${node_arch}
if [[ ! -x "$node_dir/bin/node" ]]; then
  python3 - "$node_version" "$node_sha" "$node_arch" <<'PY'
import hashlib,sys,urllib.request
from pathlib import Path
version,expected,arch=sys.argv[1:]
path=Path('/tmp/secure-node.tar.xz')
with urllib.request.urlopen('https://nodejs.org/dist/v'+version+'/node-v'+version+'-linux-'+arch+'.tar.xz',timeout=60) as source:
    data=source.read(60*1024*1024)
if hashlib.sha256(data).hexdigest()!=expected:
    raise SystemExit('Node distribution checksum mismatch')
path.write_bytes(data)
PY
  tar -xJf /tmp/secure-node.tar.xz -C /opt/secure-vm
fi
```

`scripts/install-pi.sh` 的复制命令加入 `guest/arch.sh`；`scripts/up.sh` 第一条 `limactl copy guest/...` 加入 `guest/arch.sh`。

- [x] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m unittest tests.test_constants -v && shellcheck -S warning -x guest/*.sh scripts/*.sh`
Expected: 全部 PASS，shellcheck 无输出。

- [x] **Step 5: 提交**

```bash
git add guest/arch.sh guest/cell.env guest/install-pi.sh scripts/install-pi.sh scripts/up.sh tests/test_constants.py
git commit -m "Select cell Node build by guest architecture"
```

---

### Task 2: 单模板双镜像与显式 vm-type

**Files:**
- Modify: `lima/secure-vm.yaml`、`scripts/up.sh`、`scripts/verify.sh`、`scripts/verify-onboarding.py`
- Test: `tests/test_constants.py`

**Interfaces:**
- Consumes: `host_vm_type` from `guest/arch.sh`。
- Produces: 环境变量 `ANCHI_INSTALL_VM` 可控制 `verify.sh` 与 `verify-onboarding.py` 的实例名（Task 9 的 CI 依赖）。

- [x] **Step 1: 写失败测试**

```python
class LimaTemplateTests(unittest.TestCase):
    def test_single_template_lists_both_architectures_without_fixed_driver(self):
        text = (ROOT / 'lima/secure-vm.yaml').read_text()
        top_level = [line.split(':')[0] for line in text.splitlines() if line and not line[0].isspace() and not line.startswith('#')]
        self.assertNotIn('vmType', top_level)
        self.assertNotIn('arch', top_level)
        self.assertIn('sha256:7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc', text)
        self.assertIn('sha256:ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6', text)
        self.assertIn('arch: aarch64', text)
        self.assertIn('arch: x86_64', text)
        self.assertIn('mounts: []', text)

    def test_up_script_passes_explicit_vm_type(self):
        text = (ROOT / 'scripts/up.sh').read_text()
        self.assertIn('host_vm_type', text)
        self.assertIn('--vm-type="$vm_type"', text)
        self.assertIn('ANCHI_INSTALL_VM', (ROOT / 'scripts/verify.sh').read_text())
```

- [x] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m unittest tests.test_constants -v`
Expected: 两个新用例失败（`vmType` 仍在顶层；`up.sh` 无 `host_vm_type`）。

- [x] **Step 3: 实现**

`lima/secure-vm.yaml`：

```yaml
# Dedicated development VM; never inherit Lima's home-directory mounts.
# The driver is passed explicitly by scripts/up.sh (vz on macOS, qemu on Linux);
# Lima picks the image whose arch matches the host.
minimumLimaVersion: 2.2.0
cpus: 4
memory: 4GiB
disk: 30GiB
images:
  - location: https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-arm64.img
    arch: aarch64
    digest: sha256:7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc
  - location: https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-amd64.img
    arch: x86_64
    digest: sha256:ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6
mounts: []
```

其余键（containerd、ssh、portForwards、provision）保持原文。

`scripts/up.sh` 在 `cd` 之后加入：

```bash
# shellcheck source=guest/arch.sh
source guest/arch.sh
vm_type=$(host_vm_type "$(uname -s)")
```

创建分支改为 `limactl start --tty=false --name="$vm_name" --vm-type="$vm_type" lima/secure-vm.yaml`。

`scripts/verify.sh`：

```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
vm_name=${ANCHI_INSTALL_VM:-secure-vm}
[[ "$vm_name" =~ ^secure-vm(-[a-z0-9-]+)?$ ]] || { echo "Invalid VM name" >&2; exit 1; }
for script in check-cell.py check-gmail.py check-inference.py; do
  limactl shell "$vm_name" -- sudo /usr/local/sbin/secure-cell-run /usr/bin/python3 "/opt/secure-vm/$script"
done
limactl shell "$vm_name" -- sudo /usr/bin/python3 /opt/secure-vm/check-security.py
```

`scripts/verify-onboarding.py`：

```python
import re
INSTANCE = os.environ.get('ANCHI_INSTALL_VM', 'secure-vm-onboarding-test')
if not re.fullmatch(r'secure-vm(-[a-z0-9-]+)?', INSTANCE):
    raise SystemExit('ANCHI_INSTALL_VM must look like secure-vm-<suffix>')
```

- [x] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m unittest tests.test_constants -v && shellcheck -S warning -x scripts/*.sh && limactl validate lima/secure-vm.yaml`
Expected: PASS；`limactl validate` 输出模板有效。

- [x] **Step 5: 提交**

```bash
git add lima/secure-vm.yaml scripts/up.sh scripts/verify.sh scripts/verify-onboarding.py tests/test_constants.py
git commit -m "Use one Lima template for arm64 and x86_64 hosts"
```

---

### Task 3: platform.cjs

**Files:**
- Create: `desktop/src/main/platform.cjs`
- Test: `desktop/tests/platform.test.cjs`

**Interfaces:**
- Produces: `describe({ platform, arch, home, env })` → `{ id, supported, home, toolsDirectory, nvmDirectory, tools: { brew, python, codex, limactl, qemu }, childPath, dependencies: { kind: 'brew' | 'download' | 'none', tools? }, kvmDevice, extraEnvironment, systemDirectories, secretDirectories }`；`kvmAvailable(info, access?)` → `true | false | null`；`manualSteps(info, health)` → `string[]`。

- [x] **Step 1: 写失败测试**

`desktop/tests/platform.test.cjs`：

```js
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
  for (const dir of ['/proc', '/sys', '/boot', '/root', '/run']) assert(info.systemDirectories.includes(dir));
  assert(info.secretDirectories.includes('.local/share/anchi'));
});

test('other platforms are unsupported but still describable', () => {
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    const info = describe({ platform, arch, home: '/h' });
    assert.equal(info.id, null);
    assert.equal(info.supported, false);
    assert.equal(info.dependencies.kind, 'none');
  }
});

test('kvm availability is null on macOS and follows /dev/kvm access on Linux', async () => {
  assert.equal(await kvmAvailable(describe({ platform: 'darwin', arch: 'arm64', home: '/h' })), null);
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/h' });
  assert.equal(await kvmAvailable(linux, async () => {}), true);
  assert.equal(await kvmAvailable(linux, async () => { throw Error('EACCES'); }), false);
});

test('manual steps name exactly the root actions the app refuses to run', () => {
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/h' });
  assert.deepEqual(manualSteps(linux, { qemu: true, kvm: true }), []);
  const steps = manualSteps(linux, { qemu: false, kvm: false });
  assert.equal(steps.length, 2);
  assert.match(steps[0], /apt-get install -y qemu-system-x86 qemu-utils/);
  assert.match(steps[1], /usermod -aG kvm/);
  assert.deepEqual(manualSteps(linux, { qemu: true, kvm: false }).length, 1);
  assert.deepEqual(manualSteps(describe({ platform: 'darwin', arch: 'arm64', home: '/h' }), { qemu: null, kvm: null }), []);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd desktop && node --test tests/platform.test.cjs`
Expected: `Cannot find module '../src/main/platform.cjs'`。

- [x] **Step 3: 实现**

```js
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

/**
 * The only module that knows what differs between supported hosts. Everything else asks
 * describe() for tool paths, system directories, dependency strategy and child PATH.
 */
const SECRET_DIRECTORIES = Object.freeze([
  '.ssh', '.aws', '.kube', '.codex', '.config', '.lima', '.hermes', '.gnupg', 'Library', '.local/share/anchi',
]);
const SYSTEM_DIRECTORIES = Object.freeze({
  'darwin-arm64': ['/', '/System', '/Library', '/etc', '/private', '/usr', '/bin', '/sbin', '/dev', '/var'],
  'linux-x64': ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/usr', '/var'],
});
const MANUAL = Object.freeze({
  qemu: 'sudo apt-get install -y qemu-system-x86 qemu-utils',
  kvm: 'sudo usermod -aG kvm "$USER"',
});

function describe({ platform = process.platform, arch = process.arch, home = os.homedir() } = {}) {
  const id = platform === 'darwin' && arch === 'arm64' ? 'darwin-arm64' : platform === 'linux' && arch === 'x64' ? 'linux-x64' : null;
  const toolsDirectory = path.join(home, '.local/share/anchi/tools');
  const base = {
    id, supported: id !== null, home, toolsDirectory,
    nvmDirectory: path.join(home, '.nvm/versions/node'),
    secretDirectories: SECRET_DIRECTORIES,
    systemDirectories: SYSTEM_DIRECTORIES[id] || SYSTEM_DIRECTORIES['linux-x64'],
  };
  if (id === 'darwin-arm64')
    return { ...base,
      tools: { brew: ['/opt/homebrew/bin/brew'], python: ['/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3', '/usr/bin/python3'], codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'], limactl: ['/opt/homebrew/bin/limactl', '/usr/local/bin/limactl'], qemu: [] },
      childPath: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      dependencies: { kind: 'brew' }, kvmDevice: null, extraEnvironment: [] };
  if (id === 'linux-x64')
    return { ...base,
      tools: { brew: [], python: ['/usr/bin/python3', '/usr/local/bin/python3'], codex: [path.join(toolsDirectory, 'codex/current/codex'), '/usr/local/bin/codex', path.join(home, '.npm-global/bin/codex')], limactl: [path.join(toolsDirectory, 'lima/current/bin/limactl'), '/usr/local/bin/limactl', '/usr/bin/limactl', '/home/linuxbrew/.linuxbrew/bin/limactl'], qemu: ['/usr/bin/qemu-system-x86_64', '/usr/local/bin/qemu-system-x86_64'] },
      childPath: [path.join(toolsDirectory, 'lima/current/bin'), path.join(toolsDirectory, 'codex/current'), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
      dependencies: { kind: 'download', tools: ['lima', 'codex'] }, kvmDevice: '/dev/kvm', extraEnvironment: ['XDG_RUNTIME_DIR'] };
  return { ...base, tools: { brew: [], python: ['/usr/bin/python3'], codex: [], limactl: [], qemu: [] },
    childPath: '/usr/local/bin:/usr/bin:/bin', dependencies: { kind: 'none' }, kvmDevice: null, extraEnvironment: [] };
}
async function kvmAvailable(info, access = fs.access) {
  if (!info.kvmDevice) return null;
  try { await access(info.kvmDevice, fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; }
}
function manualSteps(info, health) {
  if (info.id !== 'linux-x64') return [];
  const steps = [];
  if (health.qemu === false) steps.push(MANUAL.qemu);
  if (health.kvm === false) steps.push(MANUAL.kvm);
  return steps;
}
module.exports = { describe, kvmAvailable, manualSteps, SYSTEM_DIRECTORIES, SECRET_DIRECTORIES };
```

- [x] **Step 4: 运行确认通过**

Run: `cd desktop && npx prettier --write src/main/platform.cjs tests/platform.test.cjs && node --test tests/platform.test.cjs`
Expected: 5 PASS。

- [x] **Step 5: 提交**

```bash
git add desktop/src/main/platform.cjs desktop/tests/platform.test.cjs
git commit -m "Add host platform description for macOS and Linux"
```

---

### Task 4: host-tools、runtime、directory-store 接入 platform

**Files:**
- Modify: `desktop/src/main/host-tools.cjs`、`desktop/src/main/runtime.cjs`、`desktop/src/main/directory-store.cjs`、`desktop/src/main/app.cjs`
- Test: `desktop/tests/directory-store.test.cjs`、`desktop/tests/host-tools.test.cjs`（新建）

**Interfaces:**
- Consumes: `describe()` from Task 3。
- Produces: `executable(name, { access, readdir, platform })`；`new Runtime(root, platform)`；`new DirectoryStore(file, home, io, platform)`；`validateDirectory(chosen, home, entries, platform)`。

- [x] **Step 1: 写失败测试**

`desktop/tests/host-tools.test.cjs`：

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executable } = require('../src/main/host-tools.cjs');
const { describe } = require('../src/main/platform.cjs');
test('executables resolve only from the platform table, in order', async () => {
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/home/x' });
  const present = new Set(['/usr/bin/limactl', '/home/x/.local/share/anchi/tools/codex/current/codex']);
  const access = async (file) => { if (!present.has(file)) throw Error('ENOENT'); };
  assert.equal(await executable('limactl', { access, platform: linux }), '/usr/bin/limactl');
  assert.equal(await executable('codex', { access, readdir: async () => [], platform: linux }), '/home/x/.local/share/anchi/tools/codex/current/codex');
  assert.equal(await executable('brew', { access, platform: linux }), null);
  assert.equal(await executable('qemu', { access, platform: linux }), null);
  const mac = describe({ platform: 'darwin', arch: 'arm64', home: '/Users/x' });
  assert.equal(await executable('limactl', { access: async () => {}, platform: mac }), '/opt/homebrew/bin/limactl');
});
```

修改 `desktop/tests/directory-store.test.cjs` 的最后一个用例：

```js
test('sensitive roots, ancestors and credential stores are rejected per platform', () => {
  const { describe } = require('../src/main/platform.cjs');
  const mac = describe({ platform: 'darwin', arch: 'arm64', home: '/Users/fixture' });
  for (const dir of ['/', '/Users', '/Users/fixture', '/Users/fixture/.lima', '/Users/fixture/.ssh/sub', '/System'])
    assert.throws(() => validateDirectory(dir, '/Users/fixture', [], mac));
  assert.doesNotThrow(() => validateDirectory('/Users/fixture/docs', '/Users/fixture', [], mac));
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/home/fixture' });
  for (const dir of ['/proc', '/sys/kernel', '/root', '/home/fixture/.local/share/anchi/tools', '/home/fixture/.config'])
    assert.throws(() => validateDirectory(dir, '/home/fixture', [], linux));
  assert.doesNotThrow(() => validateDirectory('/home/fixture/docs', '/home/fixture', [], linux));
});
```

并让 `fixture()` 里的 `new DirectoryStore(file, logicalHome, io)` 改为 `new DirectoryStore(file, logicalHome, io, describe({ platform: 'darwin', arch: 'arm64', home: logicalHome }))`（两处）。

- [x] **Step 2: 运行确认失败**

Run: `cd desktop && node --test tests/host-tools.test.cjs tests/directory-store.test.cjs`
Expected: host-tools 用例失败（`platform` 选项被忽略，Linux 表返回 macOS 路径）；directory-store 的 Linux 断言失败。

- [x] **Step 3: 实现**

`host-tools.cjs`：

```js
const fs = require('node:fs/promises');
const path = require('node:path');
const { describe } = require('./platform.cjs');
/** Known installation paths only: the renderer can never supply executable paths. */
async function executable(name, { access = fs.access, readdir = fs.readdir, platform = describe() } = {}) {
  const candidates = [...(platform.tools[name] || [])];
  if (name === 'codex') {
    const versions = await readdir(platform.nvmDirectory).catch(() => []);
    candidates.push(...versions.filter((v) => /^v\d+\.\d+\.\d+$/.test(v)).sort().reverse().map((v) => path.join(platform.nvmDirectory, v, 'bin/codex')));
  }
  for (const file of candidates) {
    try { await access(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}
module.exports = { executable };
```

`runtime.cjs`：

```js
const { describe } = require('./platform.cjs');
/** Only inherited values required by Lima/SSH; never forward provider credentials. */
function childEnvironment(platform = describe()) {
  const env = { HOME: platform.home, USER: os.userInfo().username, LANG: 'en_US.UTF-8', PATH: platform.childPath, TMPDIR: os.tmpdir() };
  for (const name of platform.extraEnvironment) if (process.env[name]) env[name] = process.env[name];
  return env;
}
class Runtime {
  constructor(root, platform = describe()) { this.root = root; this.platform = platform; this.env = childEnvironment(platform); }
  async lima() { const file = await executable('limactl', { platform: this.platform }); if (!file) throw Error('LIMA_NOT_INSTALLED'); return file; }
  async python() { const file = await executable('python', { platform: this.platform }); if (!file) throw Error('PYTHON_NOT_INSTALLED'); return file; }
```

`directory-store.cjs`：`validateDirectory(chosen, home, entries, platform = describe())` 用 `platform.systemDirectories` 与 `platform.secretDirectories` 替代内联数组；`DirectoryStore` 构造增加第四参数 `platform = describe()` 并在 `load()`/`add()` 调用 `validateDirectory(..., this.platform)`。

`app.cjs`：`const platform = describe();` 传给 `new Runtime(root, platform)`、`new DirectoryStore(file, home, fs, platform)`，并保留在闭包中供 Task 6、7 使用。

- [x] **Step 4: 运行确认通过**

Run: `cd desktop && npx prettier --write src tests && npm test`
Expected: 全部 PASS（此时 46 个用例）。

- [x] **Step 5: 提交**

```bash
git add desktop/src/main/host-tools.cjs desktop/src/main/runtime.cjs desktop/src/main/directory-store.cjs desktop/src/main/app.cjs desktop/tests/host-tools.test.cjs desktop/tests/directory-store.test.cjs
git commit -m "Route host paths and directory policy through platform"
```

---

### Task 5: 固定下载清单与下载器

**Files:**
- Create: `desktop/host-tools.json`、`desktop/src/main/downloader.cjs`
- Test: `desktop/tests/downloader.test.cjs`

**Interfaces:**
- Produces: `entriesFor(platformId)` → `{ [name]: entry }`；`install(name, entry, { toolsDirectory, fetch, tar, chmod })` → 可执行文件绝对路径；`checkUrl(href)` 抛 `DOWNLOAD_HOST_NOT_ALLOWED`。错误码：`DOWNLOAD_CHECKSUM_MISMATCH`、`DOWNLOAD_TOO_LARGE`、`DOWNLOAD_TOO_MANY_REDIRECTS`、`DOWNLOAD_FAILED`。

- [x] **Step 1: 写失败测试**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { install, checkUrl, entriesFor } = require('../src/main/downloader.cjs');

async function archive(t, files) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-dl-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'src');
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), text, { mode: 0o644 });
  }
  const tarball = path.join(base, 'tool.tar.gz');
  await promisify(execFile)('/usr/bin/tar', ['-czf', tarball, '-C', source, '.']);
  const bytes = await fs.readFile(tarball);
  return { base, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), tools: path.join(base, 'tools') };
}
const respond = (status, body, headers = {}) => ({ status, headers: new Headers(headers), body: body ? Readable.from([body]) : null });

test('manifest lists pinned tools per platform with sha256', () => {
  const linux = entriesFor('linux-x64');
  for (const name of ['lima', 'codex']) {
    assert.match(linux[name].sha256, /^[a-f0-9]{64}$/);
    assert(linux[name].url.startsWith('https://github.com/'));
    assert.doesNotThrow(() => checkUrl(linux[name].url));
  }
  assert.deepEqual(entriesFor('darwin-arm64'), {});
  for (const bad of ['http://github.com/x', 'https://evil.example/x', 'file:///etc/passwd'])
    assert.throws(() => checkUrl(bad), /DOWNLOAD_HOST_NOT_ALLOWED/);
});

test('checksum mismatch leaves no executable and no current link', async (t) => {
  const { bytes, tools } = await archive(t, { 'bin/limactl': '#!/bin/sh\n' });
  const entry = { version: '1.0', url: 'https://github.com/x/y.tar.gz', sha256: 'f'.repeat(64), layout: 'tar', executable: 'bin/limactl' };
  await assert.rejects(install('lima', entry, { toolsDirectory: tools, fetch: async () => respond(200, bytes) }), /DOWNLOAD_CHECKSUM_MISMATCH/);
  assert.deepEqual(await fs.readdir(path.join(tools, 'lima')), []);
});

test('successful install follows allowed redirects, renames install_as and switches current atomically', async (t) => {
  const { bytes, sha256, tools } = await archive(t, { 'codex-x86_64-unknown-linux-musl': '#!/bin/sh\necho codex\n' });
  const entry = { version: 'v1', url: 'https://github.com/openai/codex/releases/download/v1/codex.tar.gz', sha256, layout: 'tar', executable: 'codex-x86_64-unknown-linux-musl', install_as: 'codex' };
  let calls = 0;
  const fetch = async (url) => {
    calls++;
    if (url.startsWith('https://github.com/')) return respond(302, null, { location: 'https://objects.githubusercontent.com/blob/1' });
    return respond(200, bytes);
  };
  const file = await install('codex', entry, { toolsDirectory: tools, fetch });
  assert.equal(file, path.join(tools, 'codex/v1/codex'));
  assert.equal((await fs.stat(file)).mode & 0o111, 0o111);
  assert.equal(await fs.readlink(path.join(tools, 'codex/current')), 'v1');
  assert.equal(calls, 2);
  await install('codex', entry, { toolsDirectory: tools, fetch: async () => { throw Error('MUST_NOT_DOWNLOAD_AGAIN'); } });
});

test('redirects to unknown hosts, too many hops and oversized bodies are refused', async (t) => {
  const { bytes, sha256, tools } = await archive(t, { 'bin/limactl': 'x' });
  const entry = { version: '2', url: 'https://github.com/a/b.tar.gz', sha256, layout: 'tar', executable: 'bin/limactl' };
  await assert.rejects(install('lima', entry, { toolsDirectory: tools, fetch: async () => respond(302, null, { location: 'https://evil.example/b' }) }), /DOWNLOAD_HOST_NOT_ALLOWED/);
  await assert.rejects(install('lima', entry, { toolsDirectory: tools, fetch: async (url) => respond(302, null, { location: url + '/again' }) }), /DOWNLOAD_TOO_MANY_REDIRECTS/);
  await assert.rejects(install('lima', entry, { toolsDirectory: tools, fetch: async () => respond(200, bytes), maxBytes: 4 }), /DOWNLOAD_TOO_LARGE/);
  assert.deepEqual(await fs.readdir(path.join(tools, 'lima')), []);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd desktop && node --test tests/downloader.test.cjs`
Expected: `Cannot find module '../src/main/downloader.cjs'`。

- [x] **Step 3: 实现**

`desktop/host-tools.json`：

```json
{
  "linux-x64": {
    "lima": {
      "version": "2.2.0",
      "url": "https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Linux-x86_64.tar.gz",
      "sha256": "a0ea1ccf6b7335a900adb5f8d2b8384457965fecb1ba72f09b4e3e46d12f424a",
      "layout": "tar",
      "executable": "bin/limactl"
    },
    "codex": {
      "version": "rust-v0.155.1",
      "url": "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-x86_64-unknown-linux-musl.tar.gz",
      "sha256": "a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115",
      "layout": "tar",
      "executable": "codex-x86_64-unknown-linux-musl",
      "install_as": "codex"
    }
  }
}
```

`downloader.cjs`：

```js
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const MANIFEST = require('../../host-tools.json');

/** Pinned, checksum-verified host tool downloads; nothing executes before the hash matches. */
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function entriesFor(platformId) { return MANIFEST[platformId] || {}; }
function checkUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('DOWNLOAD_HOST_NOT_ALLOWED'); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) throw Error('DOWNLOAD_HOST_NOT_ALLOWED');
  return url.href;
}
async function open(url, fetchImpl) {
  let current = checkUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(current, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Error('DOWNLOAD_FAILED');
      current = checkUrl(new URL(location, current).href);
      continue;
    }
    if (response.status !== 200 || !response.body) throw Error('DOWNLOAD_FAILED');
    return response;
  }
  throw Error('DOWNLOAD_TOO_MANY_REDIRECTS');
}
async function install(name, entry, { toolsDirectory, fetch: fetchImpl = globalThis.fetch, tar = '/usr/bin/tar', chmod = fs.chmod, maxBytes = MAX_BYTES } = {}) {
  const home = path.join(toolsDirectory, name);
  const target = path.join(home, entry.version);
  const installed = path.join(target, entry.install_as || entry.executable);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if (!(await fs.stat(installed).catch(() => null))) {
    const temporary = path.join(home, '.download-' + randomUUID());
    const partial = target + '.partial';
    try {
      const response = await open(entry.url, fetchImpl);
      const hash = createHash('sha256');
      let size = 0;
      const body = response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);
      await pipeline(body, async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxBytes) throw Error('DOWNLOAD_TOO_LARGE');
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(temporary, { mode: 0o600 }));
      if (hash.digest('hex') !== entry.sha256) throw Error('DOWNLOAD_CHECKSUM_MISMATCH');
      await fs.rm(partial, { recursive: true, force: true });
      await fs.mkdir(partial, { recursive: true, mode: 0o755 });
      await promisify(execFile)(tar, ['-xzf', temporary, '-C', partial]);
      if (entry.install_as) await fs.rename(path.join(partial, entry.executable), path.join(partial, entry.install_as));
      await chmod(path.join(partial, entry.install_as || entry.executable), 0o755);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(partial, target);
    } finally {
      await fs.rm(temporary, { force: true });
      await fs.rm(partial, { recursive: true, force: true });
    }
  }
  const link = path.join(home, 'current');
  const pending = link + '.' + randomUUID();
  await fs.symlink(entry.version, pending);
  await fs.rename(pending, link);
  return installed;
}
module.exports = { install, entriesFor, checkUrl, ALLOWED_HOSTS, MAX_BYTES };
```

- [x] **Step 4: 运行确认通过**

Run: `cd desktop && npx prettier --write src/main/downloader.cjs tests/downloader.test.cjs host-tools.json && node --test tests/downloader.test.cjs`
Expected: 4 PASS。

- [x] **Step 5: 提交**

```bash
git add desktop/host-tools.json desktop/src/main/downloader.cjs desktop/tests/downloader.test.cjs
git commit -m "Add checksum-pinned host tool downloader"
```

---

### Task 6: 首次设置的 Linux 健康检查与依赖动作

**Files:**
- Modify: `desktop/src/main/setup.cjs`、`desktop/src/main/app.cjs`
- Test: `desktop/tests/setup.test.cjs`

**Interfaces:**
- Consumes: `describe`、`kvmAvailable`、`manualSteps`（Task 3）；`entriesFor`、`install`（Task 5）；`executable(name, { platform })`（Task 4）。
- Produces: `health` 新字段 `platform`、`supported`、`qemu`、`kvm`、`manualSteps`；错误码 `PLATFORM_UNSUPPORTED` 取代 `MAC_ARM64_REQUIRED`；`new Setup({ ..., platform, install })`。

- [x] **Step 1: 写失败测试**

在 `desktop/tests/setup.test.cjs` 末尾新增：

```js
test('Linux refuses to build the VM until qemu and kvm are present, and downloads instead of brewing', async (t) => {
  const { describe } = require('../src/main/platform.cjs');
  const linux = describe({ platform: 'linux', arch: 'x64', home: '/home/x' });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-setup-linux-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const installed = [];
  const setup = new Setup({ runtime: { root: '/runtime', env: {} }, userData, notify() {}, platform: linux, install: async (name) => { installed.push(name); return '/tools/' + name; } });
  const health = { supported: true, platform: 'linux-x64', brew: false, lima: false, python: true, codex: false, qemu: false, kvm: false, freeGiB: 20, installed: false, unlocked: false, configured: false, manualSteps: ['sudo apt-get install -y qemu-system-x86 qemu-utils', 'sudo usermod -aG kvm "$USER"'] };
  setup.inspect = async () => { setup.health = { ...health }; return { health: setup.health, job: setup.job }; };
  setup.executable = async (name) => (name === 'python' ? '/usr/bin/python3' : null);
  setup.run = async () => { throw Error('BREW_MUST_NOT_RUN'); };
  await assert.rejects(setup.start('install'), /INSTALL_DEPENDENCIES_FIRST/);
  await setup.start('dependencies');
  await setup.work;
  assert.equal(setup.job.state, 'succeeded');
  assert.deepEqual(installed, ['lima', 'codex']);
  health.lima = true; health.codex = true;
  await assert.rejects(setup.start('install'), /INSTALL_DEPENDENCIES_FIRST/);
  health.qemu = true;
  await assert.rejects(setup.start('install'), /INSTALL_DEPENDENCIES_FIRST/);
  health.kvm = true;
  setup.execute = async () => {};
  await setup.start('install');
  await setup.work;
});

test('unsupported hosts fail closed with a platform error', async (t) => {
  const { describe } = require('../src/main/platform.cjs');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anchi-setup-unsupported-'));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const setup = new Setup({ runtime: { root: '/runtime', env: {} }, userData, notify() {}, platform: describe({ platform: 'win32', arch: 'x64', home: '/h' }) });
  setup.inspect = async () => { setup.health = { supported: false }; return { health: setup.health, job: null }; };
  await assert.rejects(setup.start('dependencies'), /PLATFORM_UNSUPPORTED/);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd desktop && node --test tests/setup.test.cjs`
Expected: 新用例失败（构造函数忽略 `platform`/`install`；`dependencies` 尝试 brew；错误码为 `MAC_ARM64_REQUIRED`）。

- [x] **Step 3: 实现**

`setup.cjs`：

```js
const { executable } = require('./host-tools.cjs');
const { describe, kvmAvailable, manualSteps } = require('./platform.cjs');
const downloader = require('./downloader.cjs');
...
class Setup {
  constructor({ runtime, notify, userData, spawnProcess = spawn, platform = describe(), install = downloader.install }) {
    Object.assign(this, { runtime, notify, userData, spawnProcess, platform, install });
    ...
  }
  executable(name) { return executable(name, { platform: this.platform }); }
  async inspect() {
    const info = this.platform;
    const [brew, python, codex, lima, qemu, kvm] = await Promise.all([
      this.executable('brew'), this.executable('python'), this.executable('codex'),
      this.runtime.lima().catch(() => null), this.executable('qemu'), kvmAvailable(info),
    ]);
    const health = {
      platform: info.id, supported: info.supported,
      brew: !!brew, python: !!python, codex: !!codex, lima: !!lima,
      qemu: info.id === 'linux-x64' ? !!qemu : null, kvm,
      vm: 'missing', freeGiB: ..., installed: false, unlocked: false, configured: false,
    };
    health.manualSteps = manualSteps(info, health);
    ... (原有 VM 探测不变)
  }
  async start(action) {
    ...
    if (!health.supported) throw Error('PLATFORM_UNSUPPORTED');
    if (action === 'install' && health.freeGiB < 8) throw Error('DISK_SPACE_REQUIRED');
    if (action === 'dependencies' && this.platform.dependencies.kind === 'brew' && !health.brew) throw Error('HOMEBREW_REQUIRED');
    if (action !== 'dependencies' && (!health.lima || !health.python || health.qemu === false || health.kvm === false))
      throw Error('INSTALL_DEPENDENCIES_FIRST');
    ...
  }
  async execute(action) {
    if (action === 'dependencies') {
      const plan = this.platform.dependencies;
      if (plan.kind === 'brew') {
        const brew = await this.executable('brew');
        await this.run(brew, ['install', 'lima', 'python@3.13']);
        if (!(await this.executable('codex'))) await this.run(brew, ['install', '--cask', 'codex']);
      } else if (plan.kind === 'download') {
        const entries = downloader.entriesFor(this.platform.id);
        for (const name of plan.tools) {
          const present = await this.executable(name === 'lima' ? 'limactl' : name);
          if (present) continue;
          await this.install(name, entries[name], { toolsDirectory: this.platform.toolsDirectory });
        }
      } else throw Error('PLATFORM_UNSUPPORTED');
    } else if (action === 'install') { ...不变... }
```

其余不变。`app.cjs` 的 `new Setup({...})` 传 `platform`。

- [x] **Step 4: 运行确认通过**

Run: `cd desktop && npx prettier --write src tests && npm test`
Expected: 全部 PASS。

- [x] **Step 5: 提交**

```bash
git add desktop/src/main/setup.cjs desktop/src/main/app.cjs desktop/tests/setup.test.cjs
git commit -m "Gate Linux setup on QEMU and KVM and download tools without root"
```

---

### Task 7: 渲染器与首次设置文案

**Files:**
- Modify: `desktop/src/renderer/views.mjs`、`desktop/src/renderer/renderer.mjs`、`desktop/src/main/app.cjs`
- Test: `desktop/tests/views.test.cjs`

**Interfaces:**
- Consumes: `health.platform`、`health.qemu`、`health.kvm`、`health.manualSteps`（Task 6）。
- Produces: 动作 `setup-homebrew` 在 Linux 上打开 `https://github.com/jwfing/anchi/blob/main/docs/GETTING_STARTED.md#linux`。

- [x] **Step 1: 写失败测试**

```js
test('setup step 1 shows Linux manual root commands and no Homebrew wording', async () => {
  const { renderPage } = await import('../src/renderer/views.mjs');
  const html = renderPage({
    page: 'setup', messages: [], approvals: [],
    state: { directories: [], events: [], setup: { health: { supported: true, platform: 'linux-x64', brew: false, lima: false, python: true, codex: false, qemu: false, kvm: false, freeGiB: 30, vm: 'missing', installed: false, unlocked: false, configured: false, manualSteps: ['sudo apt-get install -y qemu-system-x86 qemu-utils', 'sudo usermod -aG kvm "$USER"'] } } },
  });
  assert(html.includes('qemu-system-x86'));
  assert(html.includes('usermod -aG kvm &quot;$USER&quot;'));
  assert(html.includes('下载 Lima 与 Codex'));
  assert(!html.includes('Homebrew'));
  assert(html.includes('QEMU：待完成'));
  const unsupported = renderPage({ page: 'setup', messages: [], approvals: [], state: { directories: [], events: [], setup: { health: { supported: false } } } });
  assert(unsupported.includes('x86_64 Linux'));
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd desktop && node --test tests/views.test.cjs`
Expected: 新用例失败（页面仍显示 Homebrew 文案）。

- [x] **Step 3: 实现**

`views.mjs` 的步骤一卡片：

```js
const linux = h.platform === 'linux-x64';
const stepOne = linux
  ? `<div class="card"><h2>1 · 准备系统环境</h2><p>Lima：${label(h.lima)} · Codex：${label(h.codex)} · Python：${label(h.python)} · QEMU：${label(h.qemu)} · KVM：${label(h.kvm)}</p>
      <p class="muted">Lima 与 Codex 由应用按固定版本和 SHA-256 下载到 ~/.local/share/anchi/tools，不需要管理员密码。当前可用磁盘 ${esc(h.freeGiB)} GB；安装至少需要 8 GB。</p>
      ${h.manualSteps?.length ? `<p>QEMU 与 KVM 权限需要你在终端执行：</p><pre>${esc(h.manualSteps.join('\n'))}</pre><p class="caption">执行后退出登录并重新登录，再点「重新检查」。</p>` : ''}
      <div class="actions">${stepButton('下载 Lima 与 Codex', 'setup-dependencies')}${button('查看 Linux 安装说明', 'setup-homebrew')}</div></div>`
  : `...原有 macOS 卡片...`;
```

不支持平台文案改为「此版本支持 Apple Silicon Mac 和 x86_64 Linux。请在支持的设备上运行。」。

`renderer.mjs` 的 `errors` 增加 `PLATFORM_UNSUPPORTED: '此版本支持 Apple Silicon Mac 和 x86_64 Linux。'`，并把 `DOWNLOAD_CHECKSUM_MISMATCH`、`DOWNLOAD_HOST_NOT_ALLOWED`、`DOWNLOAD_TOO_LARGE`、`DOWNLOAD_FAILED` 映射为「下载校验失败，未安装任何文件。请检查网络后重试。」。

`app.cjs`：

```js
async openDependencyInstaller() {
  await shell.openExternal(platform.id === 'linux-x64'
    ? 'https://github.com/jwfing/anchi/blob/main/docs/GETTING_STARTED.md#linux'
    : 'https://github.com/Homebrew/brew/releases/latest');
},
```

- [x] **Step 4: 运行确认通过**

Run: `cd desktop && npx prettier --write src tests && npm test`
Expected: 全部 PASS。

- [x] **Step 5: 提交**

```bash
git add desktop/src/renderer/views.mjs desktop/src/renderer/renderer.mjs desktop/src/main/app.cjs desktop/tests/views.test.cjs
git commit -m "Show Linux setup steps in the first-run page"
```

---

### Task 8: 打包目标与打包冒烟矩阵

**Files:**
- Create: `desktop/scripts/package-target.cjs`
- Modify: `desktop/scripts/package.cjs`、`.github/workflows/check.yml`
- Test: `desktop/tests/package.test.cjs`

**Interfaces:**
- Produces: `targetFor(info)` → `{ platform, arch, directory, archive } | null`，其中 `directory` 为 `Anchi-darwin-arm64` 或 `Anchi-linux-x64`，`archive` 为 `Anchi-mac-arm64.zip` 或 `Anchi-linux-x64.tar.gz`。

- [x] **Step 1: 写失败测试**

```js
test('packaging targets follow the host platform and refuse others', () => {
  const { targetFor } = require('../scripts/package-target.cjs');
  const { describe } = require('../src/main/platform.cjs');
  assert.deepEqual(targetFor(describe({ platform: 'darwin', arch: 'arm64', home: '/h' })), { platform: 'darwin', arch: 'arm64', directory: 'Anchi-darwin-arm64', archive: 'Anchi-mac-arm64.zip' });
  assert.deepEqual(targetFor(describe({ platform: 'linux', arch: 'x64', home: '/h' })), { platform: 'linux', arch: 'x64', directory: 'Anchi-linux-x64', archive: 'Anchi-linux-x64.tar.gz' });
  assert.equal(targetFor(describe({ platform: 'win32', arch: 'x64', home: '/h' })), null);
});
```

- [x] **Step 2: 运行确认失败**

Run: `cd desktop && node --test tests/package.test.cjs`
Expected: `Cannot find module '../scripts/package-target.cjs'`。

- [x] **Step 3: 实现**

`package-target.cjs`：

```js
const TARGETS = Object.freeze({
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', directory: 'Anchi-darwin-arm64', archive: 'Anchi-mac-arm64.zip' },
  'linux-x64': { platform: 'linux', arch: 'x64', directory: 'Anchi-linux-x64', archive: 'Anchi-linux-x64.tar.gz' },
});
function targetFor(info) { return TARGETS[info.id] ? { ...TARGETS[info.id] } : null; }
module.exports = { targetFor, TARGETS };
```

`package.cjs` 的 `main()`：

```js
const { describe } = require('../src/main/platform.cjs');
const { targetFor } = require('./package-target.cjs');
const target = targetFor(describe());
if (!target) throw Error('Packaging supports macOS arm64 and Linux x64 hosts only.');
const config = releaseConfiguration(process.env);
if (config && target.platform !== 'darwin') throw Error('RELEASE_UNSUPPORTED_PLATFORM');
...
for (const name of ['build-manifest.json', 'notarization.json', target.archive, target.archive + '.sha256']) await fs.rm(path.join(out, name), { force: true });
const results = await packager({ dir: directory, name: pkg.productName, platform: target.platform, arch: target.arch, out, overwrite: true, asar: true,
  ...(target.platform === 'darwin' ? { appBundleId: config?.bundleId || 'local.anchi.desktop', ...(config ? { osxSign: {...} } : {}) } : {}),
  appVersion: pkg.version, extraResource: [...], ignore: [...] });
let release = {};
if (config) release = await notarize(...);
else if (target.platform === 'linux') {
  const archive = path.join(out, target.archive);
  await promisify(execFile)('/usr/bin/tar', ['-czf', archive, '-C', out, target.directory]);
  const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(archive + '.sha256', sha256 + '  ' + target.archive + '\n');
  release = { archive: target.archive, sha256 };
}
// build-manifest: platform: target.platform, arch: target.arch
```

`.github/workflows/check.yml` 的 `package-smoke`：

```yaml
  package-smoke:
    if: github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/main')
    needs: offline
    strategy:
      matrix:
        os: [macos-14, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 25
    steps:
      ... (checkout, node, python, pip, npm ci desktop, npm ci pi 同前)
      - run: node desktop/scripts/package.cjs
      - name: Verify artifact
        shell: bash
        run: |
          version=$(node -p "require('./desktop/package.json').version")
          case "$RUNNER_OS" in
            macOS) test -d "artifacts/releases/$version/Anchi-darwin-arm64/Anchi.app" ;;
            Linux) cd "artifacts/releases/$version" && sha256sum -c Anchi-linux-x64.tar.gz.sha256 ;;
          esac
```

- [x] **Step 4: 运行确认通过**

Run: `cd desktop && npx prettier --write scripts tests && npm test && node scripts/check.cjs`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add desktop/scripts/package-target.cjs desktop/scripts/package.cjs desktop/tests/package.test.cjs .github/workflows/check.yml
git commit -m "Package a Linux x64 tarball and smoke it in CI"
```

---

### Task 9: CI 工具安装脚本与 linux-live 工作流

**Files:**
- Create: `desktop/scripts/install-host-tool.cjs`、`.github/workflows/linux-live.yml`
- Test: `desktop/scripts/check.cjs` 已覆盖语法；工作流由 Task 11 首次运行验证。

**Interfaces:**
- Consumes: `describe`、`entriesFor`、`install`。
- Produces: `node desktop/scripts/install-host-tool.cjs <name>` 输出安装后的可执行文件路径，退出码非零表示失败。

- [x] **Step 1: 实现脚本**

```js
// Install one pinned host tool from desktop/host-tools.json for the current platform.
// Used by first-run setup indirectly and by CI directly; stdlib only, no npm install needed.
const { describe } = require('../src/main/platform.cjs');
const { entriesFor, install } = require('../src/main/downloader.cjs');
async function main() {
  const name = process.argv[2];
  const info = describe();
  const entry = entriesFor(info.id)[name];
  if (!entry) throw Error(`No pinned download for ${name} on ${info.id || 'unsupported platform'}`);
  console.log(await install(name, entry, { toolsDirectory: info.toolsDirectory }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
```

- [x] **Step 2: 写工作流**

`.github/workflows/linux-live.yml`：

```yaml
name: Linux live validation

on:
  workflow_dispatch:
  schedule:
    - cron: '0 3 * * 1'

permissions:
  contents: read

jobs:
  kvm-guest:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      ANCHI_INSTALL_VM: secure-vm-onboarding-test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - uses: actions/setup-python@v5
        with:
          python-version: '3.13'
      - name: Enable KVM for the runner user
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
          ls -la /dev/kvm
      - name: Install QEMU
        run: |
          sudo apt-get update
          sudo apt-get install -y qemu-system-x86 qemu-utils
          qemu-system-x86_64 --version | head -1
      - name: Install Lima with the app downloader
        run: |
          node desktop/scripts/install-host-tool.cjs lima
          echo "$HOME/.local/share/anchi/tools/lima/current/bin" >> "$GITHUB_PATH"
      - run: limactl --version
      - name: Create the guest and install Pi
        run: bash scripts/install-pi.sh
      - name: Onboarding checks with synthetic credentials
        run: python3 scripts/verify-onboarding.py
      - name: Installer retry keeps state
        run: python3 scripts/verify-onboarding.py --retry
      - name: Isolation and service checks
        run: bash scripts/verify.sh
      - name: Collect Lima logs
        if: always()
        run: |
          mkdir -p logs
          cp "$HOME/.lima/$ANCHI_INSTALL_VM"/*.log logs/ 2>/dev/null || true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: lima-logs
          path: logs
          if-no-files-found: ignore
      - name: Delete the guest
        if: always()
        run: limactl delete -f "$ANCHI_INSTALL_VM" || true
```

- [x] **Step 3: 本地检查**

Run: `cd desktop && npx prettier --write scripts/install-host-tool.cjs && node scripts/check.cjs && node -e "require('./scripts/install-host-tool.cjs')" ; echo`
Expected: 语法通过；在 macOS 上直接运行脚本输出 `No pinned download for undefined on darwin-arm64` 并退出码 1（预期行为）。

- [x] **Step 4: 提交**

```bash
git add desktop/scripts/install-host-tool.cjs .github/workflows/linux-live.yml
git commit -m "Add KVM-backed Linux live validation workflow"
```

---

### Task 10: 文档与变更记录

**Files:**
- Modify: `README.md`、`README.en.md`、`docs/GETTING_STARTED.md`、`SECURITY.md`、`docs/engineering/RELEASE.md`、`docs/architecture/REPOSITORY.md`、`CHANGELOG.md`、`docs/README.md`

- [x] **Step 1: README 支持矩阵**

在 `README.md`「开发与运行」段落前加入：

```markdown
## 支持的宿主

| 宿主 | 状态 | 隔离层 |
|---|---|---|
| macOS Apple Silicon | 支持 | Lima + Virtualization.framework |
| Linux x86_64（Ubuntu 22.04+/Debian 12+） | 实验性，由 CI 在 KVM runner 上验证 | Lima + QEMU/KVM |
| 其他 | 不支持 | |
```

`README.en.md` 加同样的表（英文）。

- [x] **Step 2: GETTING_STARTED Linux 段**

在文末新增 `## Linux`（锚点 `#linux`）：

```markdown
## Linux

支持 x86_64 的 Ubuntu 22.04+ 与 Debian 12+，需要 CPU 虚拟化扩展与 `/dev/kvm`。

1. 解压 `Anchi-linux-x64.tar.gz`，运行 `Anchi-linux-x64/Anchi`。若发行版禁用非特权用户命名空间，Electron 会提示沙箱错误，此时执行一次 `sudo chown root Anchi-linux-x64/chrome-sandbox && sudo chmod 4755 Anchi-linux-x64/chrome-sandbox`；不要用 `--no-sandbox` 绕过。
2. 首次设置步骤 1 点击「下载 Lima 与 Codex」。应用按固定版本与 SHA-256 下载到 `~/.local/share/anchi/tools`，不需要管理员密码。
3. QEMU 与 KVM 权限需要你在终端执行页面上显示的两条命令：`sudo apt-get install -y qemu-system-x86 qemu-utils` 与 `sudo usermod -aG kvm "$USER"`。执行后退出登录并重新登录，再点「重新检查」。
4. 之后的步骤与 macOS 相同。配置目录为 `~/.config/Anchi`，主密钥为 `~/.config/secure-vm/vault.key`。
5. Codex 登录会打开系统浏览器；Linux 上的 Codex 二进制由应用下载，版本固定，升级随应用发布。
```

- [x] **Step 3: SECURITY / RELEASE / REPOSITORY / CHANGELOG**

`SECURITY.md`「当前边界」末尾加一段：

```markdown
Linux 宿主与 macOS 使用相同的信任边界：可信服务与 cell 仍在 Lima 管理的虚拟机内，只是驱动换成 QEMU/KVM，网络为 QEMU 用户态 NAT。`/dev/kvm` 的访问权限由宿主管理员决定。应用下载的 Lima 与 Codex 只按固定的 SHA-256 校验，不校验 Lima 的 GPG 签名或 Codex 的 sigstore 签名。
```

`docs/engineering/RELEASE.md` 增加「Linux 产物」段：tar.gz 与 `.sha256`，无签名；`host-tools.json` 升级流程（改版本与 URL、重算 SHA、运行 linux-live）。

`docs/architecture/REPOSITORY.md` 目录树加入 `platform.cjs`、`downloader.cjs`、`host-tools.json`、`scripts/package-target.cjs`、`scripts/install-host-tool.cjs`、`guest/arch.sh`；关键决定加「10. 平台差异只存在于 platform.cjs 与 guest/arch.sh；宿主工具下载版本固定在 host-tools.json」。

`CHANGELOG.md` Unreleased 新增：

```markdown
- Linux x86_64 客户端（实验性）：Lima + QEMU/KVM，单一 VM 模板双镜像，首次设置自动下载 Lima 与 Codex，QEMU/KVM 需用户手工执行两条命令；`Anchi-linux-x64.tar.gz` 产物；`linux-live` 工作流在 KVM runner 上从零建 VM 验收。
```

`docs/README.md` 加入设计与计划文档链接。

- [x] **Step 4: 提交**

```bash
git add README.md README.en.md docs/GETTING_STARTED.md SECURITY.md docs/engineering/RELEASE.md docs/architecture/REPOSITORY.md CHANGELOG.md docs/README.md
git commit -m "Document the Linux client and its trust boundary"
```

---

### Task 11: macOS 回归、推送并运行 linux-live

**Files:** 无新增；修正 CI 暴露的问题时按对应任务的文件提交。

- [x] **Step 1: 全量离线检查**

Run: `make check PYTHON=.venv/bin/python`
Expected: lint 通过；桌面、Pi、Python 三套测试全部通过。

- [x] **Step 2: macOS 真机回归**

Run:
```bash
limactl validate lima/secure-vm.yaml
bash scripts/up.sh            # 现有实例：只重装 guest 脚本与服务
make verify-vm
node desktop/scripts/verify-files.cjs
```
Expected: 模板有效；77 项检查通过；文件代理往返通过。

- [x] **Step 3: 推送分支并触发 linux-live**

Run:
```bash
git push -u origin feat/linux-client
gh workflow run linux-live.yml --ref feat/linux-client
gh run list --workflow linux-live.yml --branch feat/linux-client --limit 1
```
Expected: 工作流排队；用 `gh run watch <id> --exit-status` 等待结果。

- [x] **Step 4: 处理失败**

若某步失败：`gh run view <id> --log-failed`，下载 `lima-logs` artifact；按失败所在任务修改代码，补充或修正测试，重跑 `make check`，提交，再次 `gh workflow run`。直到 linux-live 全部步骤通过。

- [x] **Step 5: 记录**

新增 `docs/engineering/VALIDATION-<日期>-LINUX.md`：linux-live 运行 ID、耗时、通过的检查数、未覆盖项（图形界面走查、Codex 真实登录）。提交。
