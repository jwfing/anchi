# Linux 客户端设计

日期：2026-09-20。状态：设计已与维护者逐节确认，待实施计划。

## 1. 目标与非目标

目标：让 Anchi 桌面在 x86_64 Linux 上完成与 macOS 相同的闭环：首次设置、创建 secure-vm、安装 Pi、解锁凭证库、导入 Codex 订阅认证、聊天与独立审批、目录授权与 Gmail 连接。安全边界与 macOS 完全相同：可信服务与 cell 都在 Lima 管理的虚拟机内，宿主只保留桌面控制面、主密钥文件和文件代理。

非目标（第一版）：arm64 Linux 宿主；Ubuntu/Debian 之外发行版的依赖自动安装；.deb 或 AppImage；宿主直接运行 systemd-nspawn 的无虚拟机模式；跨平台交叉打包；Intel Mac。

## 2. 已确认的决策

| 决策 | 结果 |
|---|---|
| 隔离层 | Lima + QEMU/KVM 虚拟机，guest 脚本、systemd、nftables、验收脚本全部复用 |
| 宿主范围 | x86_64；Ubuntu 22.04+/Debian 12+ 优先，其他发行版只检测并提示 |
| 依赖安装 | 应用按固定版本与 SHA-256 自行下载 Lima 与 Codex CLI 到用户目录；qemu 与 kvm 组权限需要 root，应用只展示命令，绝不请求管理员密码 |
| 产物 | `Anchi-linux-x64.tar.gz` 加 `.sha256`，不签名 |
| 真机验证 | GitHub Actions x86_64 ubuntu runner 启用 KVM，从零创建 VM 并运行现有验收脚本 |
| 代码组织 | 单一 Lima 模板；桌面新增 `platform.cjs` 集中全部平台差异；guest 脚本按架构自适应 |

## 3. 隔离层与 guest

### 3.1 Lima 模板

`lima/secure-vm.yaml` 删除 `vmType: vz` 与 `arch: aarch64`。`images` 列出两项，Lima 按宿主架构选择：

| arch | location | digest |
|---|---|---|
| aarch64 | `.../release-20260705/ubuntu-24.04-server-cloudimg-arm64.img` | `sha256:7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc` |
| x86_64 | `.../release-20260705/ubuntu-24.04-server-cloudimg-amd64.img` | `sha256:ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6` |

`minimumLimaVersion: 2.2.0`、cpus/memory/disk、`mounts: []`、端口转发忽略、provision 脚本不变。

驱动不依赖默认值：`scripts/up.sh` 创建实例时按 `uname -s` 显式传 `--vm-type=vz`（Darwin）或 `--vm-type=qemu`（Linux）。已存在的实例由 `limactl start <name>` 启动，vmType 在创建时固定，macOS 现有用户不受影响。Lima 自 v1.0 起在 macOS 13.5+ 默认 vz、Linux 默认 qemu，显式传参只是把这一点写进代码。

### 3.2 cell 内 Node 按架构选择

`guest/cell.env` 把 `SECURE_NODE_SHA256` 拆为两项：

```
SECURE_NODE_SHA256_ARM64=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
SECURE_NODE_SHA256_X64=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
```

新增 `guest/arch.sh`，提供 `node_arch()`：`aarch64 → arm64`，`x86_64 → x64`，其他架构返回非零。`guest/install-pi.sh` source 它，按结果拼接 Node 下载名 `node-v<ver>-linux-<arch>.tar.xz` 与对应 SHA，目录名 `node-v<ver>-linux-<arch>`。`guest/check-pi.py` 的版本断言不变。debootstrap 本来就是原生架构，cell rootfs 在 amd64 guest 里自然是 amd64。`tests/test_constants.py` 断言两个 SHA 都存在且为 64 位十六进制；新增一个用 `bash -c` 调用 `node_arch` 的测试。

### 3.3 实例名参数化

`scripts/verify.sh` 与 `scripts/verify-onboarding.py` 的实例名改为 `ANCHI_INSTALL_VM` 环境变量，默认值保持现状。其余宿主 CLI 仍固定 `secure-vm`。

## 4. 桌面

### 4.1 platform.cjs

`desktop/src/main/platform.cjs` 导出 `describe({ platform, arch, home } = process)`，返回：

- `id`：`'darwin-arm64'`、`'linux-x64'` 或 `null`；`supported` 为 `id !== null`。
- `tools`：各工具的已知路径数组，取代 `host-tools.cjs` 里的常量。Linux：
  - `limactl`：`~/.local/share/anchi/tools/lima/current/bin/limactl`、`/usr/local/bin/limactl`、`/usr/bin/limactl`、`/home/linuxbrew/.linuxbrew/bin/limactl`
  - `codex`：`~/.local/share/anchi/tools/codex/current/codex`、`/usr/local/bin/codex`、`~/.npm-global/bin/codex`、nvm 目录
  - `python`：`/usr/bin/python3`、`/usr/local/bin/python3`
  - `qemu`：`/usr/bin/qemu-system-x86_64`、`/usr/local/bin/qemu-system-x86_64`
  - `brew`：空（Linux 不使用）
- `kvm`：`/dev/kvm` 可读写检测函数（仅 Linux）。
- `systemDirectories`：macOS 沿用现有列表；Linux 为 `/`、`/bin`、`/boot`、`/dev`、`/etc`、`/lib`、`/lib64`、`/opt`、`/proc`、`/root`、`/run`、`/sbin`、`/snap`、`/srv`、`/sys`、`/usr`、`/var`。`secretDirectories` 两平台共用，新增 `.local/share/anchi`。
- `childPath`：子进程 PATH。macOS 不变；Linux 为工具目录的 `lima/current/bin`、`codex/current`，再加 `/usr/local/bin:/usr/bin:/bin`。
- `dependencies`：`{ kind: 'brew' }` 或 `{ kind: 'download', tools: ['lima', 'codex'] }`。
- `manualSteps(health)`：Linux 缺 qemu 时返回 `sudo apt-get install -y qemu-system-x86 qemu-utils`；缺 kvm 权限时返回 `sudo usermod -aG kvm $USER` 并提示重新登录。macOS 返回空。

`host-tools.cjs`、`runtime.cjs`、`setup.cjs`、`directory-store.cjs`、`package.cjs` 只通过 `platform.describe()` 取这些值，不再直接判断 `process.platform`。

### 4.2 固定下载清单与下载器

`desktop/host-tools.json` 随应用打包，按平台列出可下载工具：

```json
{
  "linux-x64": {
    "lima": {
      "version": "2.2.0",
      "url": "https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Linux-x86_64.tar.gz",
      "sha256": "a0ea1ccf6b7335a900adb5f8d2b8384457965fecb1ba72f09b4e3e46d12f424a",
      "layout": "tar", "executable": "bin/limactl"
    },
    "codex": {
      "version": "rust-v0.155.1",
      "url": "https://github.com/openai/codex/releases/download/rust-v0.155.1/codex-x86_64-unknown-linux-musl.tar.gz",
      "sha256": "a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115",
      "layout": "tar", "executable": "codex-x86_64-unknown-linux-musl", "install_as": "codex"
    }
  }
}
```

Lima 的 SHA 来自其发布页 `SHA256SUMS`；Codex 只提供 sigstore 签名，SHA 由维护者在固定版本时下载计算并记录。两者都只校验 SHA-256，不校验 GPG 或 sigstore，安全声明如实写出。版本升级是手工流程：改 JSON、重算 SHA、跑 linux-live 工作流。

`desktop/src/main/downloader.cjs` 导出 `install(entry, { toolsDir, fetch, tar })`：

1. 只接受 `https:`；最多 3 次重定向，且主机限定为 `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`。
2. 流式写入 `<toolsDir>/<name>/.download-<uuid>`，同时计算 SHA-256，超过 300 MB 中止。
3. SHA 不匹配立即删除临时文件并抛 `DOWNLOAD_CHECKSUM_MISMATCH`，不解压任何内容。
4. 解压到 `<toolsDir>/<name>/<version>.partial`，`layout: tar` 用 `/usr/bin/tar -xzf`；`install_as` 存在时把单文件重命名；`chmod 0755` 可执行文件。
5. 重命名为 `<version>`，再用临时符号链接加 `rename` 原子切换 `current`。已存在同版本目录时跳过下载。

### 4.3 首次设置

`Setup.inspect()` 的 `health` 新增 `platform`、`qemu`、`kvm`、`manualSteps`；`supported` 改由 platform 判定。前置条件：

- `dependencies`：macOS 要求 brew；Linux 无前置，动作为下载 Lima 与 Codex（缺哪个下哪个），从不调用 sudo。
- `install`：两平台都要求 lima 与 python；Linux 另要求 `qemu` 与 `kvm`，否则抛 `INSTALL_DEPENDENCIES_FIRST` 并在健康信息里携带 `manualSteps`。
- `unlock`、`login`、`import` 不变。

`login` 动作在 Linux 上直接运行下载的 `codex login`，浏览器由 Codex 打开。`executable('codex')` 的 nvm 扫描保留。

渲染器步骤一按 `health.platform` 分支：macOS 文案不变；Linux 显示 Lima、Codex、QEMU、KVM 四项就绪状态，`manualSteps` 非空时用 `<pre>` 逐行列出命令并注明「执行后重新登录，再点重新检查」，按钮文字为「下载 Lima 与 Codex」。不支持的平台提示改为「此版本支持 Apple Silicon Mac 和 x86_64 Linux」。`app.cjs` 的 Homebrew 下载页按钮在 Linux 上打开使用指南的 Linux 段落链接。

### 4.4 其他桌面改动

- `runtime.cjs`：`childEnvironment()` 的 PATH 来自 `platform.childPath`；保留 HOME、USER、LANG、TMPDIR；Linux 额外透传 `XDG_RUNTIME_DIR`（若存在）。
- `directory-store.cjs`：`validateDirectory` 的系统目录与凭证目录列表来自 platform。
- Electron 在 Linux 的用户数据目录为 `~/.config/Anchi`，`resolveUserData` 的 Qisuo 迁移逻辑无副作用。
- `file-broker.cjs` 已经通过 `runtime.python()` 取宿主 Python，无需改动。
- 菜单与对话框为 Electron 跨平台 API，不改。

## 5. 打包与 CI

### 5.1 打包

`desktop/scripts/package.cjs` 按运行平台决定目标：macOS arm64 产出现有 `Anchi-darwin-arm64`；Linux x64 产出 `artifacts/releases/<version>/Anchi-linux-x64/` 目录，随后 `tar -czf Anchi-linux-x64.tar.gz` 并写 `Anchi-linux-x64.tar.gz.sha256`。Linux 无签名分支，`ANCHI_RELEASE=1` 在 Linux 上直接报错 `RELEASE_UNSUPPORTED_PLATFORM`。`build-manifest.json` 记录 `platform` 与 `arch`。运行资源打包（`runtime-bundle.cjs`）不变，脚本均为 POSIX shell 与 Python。

### 5.2 现有 CI

`check.yml` 的 `package-smoke` 改为矩阵 `[macos-14, ubuntu-latest]`，ubuntu 上断言 tar.gz 与 sha256 文件存在。

### 5.3 linux-live 工作流

新增 `.github/workflows/linux-live.yml`，`workflow_dispatch` 加每周一次 `schedule`，`runs-on: ubuntu-latest`，超时 60 分钟：

1. 启用 KVM：写入 `/etc/udev/rules.d/99-kvm4all.rules`（`KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"`），`udevadm control --reload-rules` 与 `udevadm trigger --name-match=kvm`。
2. `sudo apt-get install -y qemu-system-x86 qemu-utils`。
3. 用一个小 Node 脚本调用 `downloader.cjs` 安装 `host-tools.json` 里的 Lima（顺带验证下载器），把 `~/.local/share/anchi/tools/lima/current/bin` 加入 `GITHUB_PATH`。
4. `ANCHI_INSTALL_VM=secure-vm-onboarding-test bash scripts/install-pi.sh`：从模板创建 amd64 VM，完成 bootstrap、服务安装与 Pi 安装。
5. `python3 scripts/verify-onboarding.py` 与 `--retry`。
6. `ANCHI_INSTALL_VM=secure-vm-onboarding-test bash scripts/verify.sh`。
7. `always()` 步骤 `limactl delete -f`，并上传 `~/.lima/<name>/ha.stderr.log` 等日志为 artifact 便于排错。

CI 不登录 Codex、不连接 Google、不调用模型；沿用合成令牌。arm64 runner 无 `/dev/kvm`，工作流固定 x86_64。

## 6. 文档与安全声明

- `README.md`、`README.en.md`：支持矩阵，macOS Apple Silicon 为正式支持，Linux x86_64 标为实验性。
- `docs/GETTING_STARTED.md`：新增 Linux 段：前置条件（x86_64、Ubuntu 22.04+/Debian 12+、KVM 可用、约 4 GB 空闲内存、8 GB 磁盘）、两条需要 root 的命令、kvm 组需重新登录、工具目录 `~/.local/share/anchi/tools`、配置目录 `~/.config/Anchi`、主密钥 `~/.config/secure-vm/vault.key`。
- `SECURITY.md`：Linux 的信任边界与 macOS 相同，仍在 VM 内；QEMU 用户态网络；`/dev/kvm` 权限属宿主管理员；下载的宿主工具只按固定 SHA-256 校验，不校验 Lima 的 GPG 签名与 Codex 的 sigstore 签名。
- `docs/engineering/RELEASE.md`：Linux tar.gz 产物与无签名说明，host-tools.json 的版本升级流程。
- `docs/architecture/REPOSITORY.md`：`platform.cjs`、`downloader.cjs`、`host-tools.json`、`guest/arch.sh`。
- `CHANGELOG.md`：Unreleased 新增条目。

## 7. 测试

离线（进入 `make check`）：

- `platform.test.cjs`：darwin/arm64、linux/x64 的路径表与 PATH，其他平台 `supported=false`；`manualSteps` 在缺 qemu、缺 kvm、都缺三种情况下的输出。
- `downloader.test.cjs`：注入假的 `fetch` 返回预置响应，不访问网络；下载器对初始 URL 与每次重定向都执行 `https:` 与主机白名单检查。用例：SHA 不匹配不产生任何文件；超过大小上限中止；重定向到非白名单主机拒绝；`http:` URL 拒绝；成功路径生成 `current` 链接与可执行位；同版本已存在时不重复下载。
- `setup.test.cjs`：Linux 健康信息下缺 qemu 或 kvm 时 `install` 被拒且携带 `manualSteps`；`dependencies` 调用下载器而非 brew；macOS 行为回归。
- `directory-store.test.cjs`：Linux 系统目录与 `.local/share/anchi` 被拒。
- `package.test.cjs`：目标名与产物文件名按平台生成。
- `tests/test_constants.py`：双 SHA；`node_arch` 映射。

真机：linux-live 工作流是 Linux 路径的唯一验证。macOS 侧：`limactl validate lima/secure-vm.yaml`；在现有 secure-vm 上重跑 `bash scripts/up.sh` 确认无回归；`make verify-vm` 与 `verify-files.cjs` 继续通过。

## 8. 风险与应对

- Ubuntu 22.04 的 QEMU 6.2 是 Lima 的最低版本，Debian 12 为 7.2，Ubuntu 24.04 为 8.2；文档写明最低要求。
- GitHub runner 磁盘约 14 GB 可用，VM 稀疏盘实际增长约 3 到 4 GB，工作流结束删除实例。
- Lima 若未来改变默认驱动，`--vm-type` 显式传参不受影响。
- Codex Linux 二进制约 100 MB，下载器有大小上限与断点重下（重下即重新开始，不做续传）。
- Linux 桌面上 Electron 沙箱依赖内核用户命名空间或 SUID chrome-sandbox；tar.gz 解包后保留 `chrome-sandbox` 的 4755 权限说明写入 GETTING_STARTED，若发行版禁用非特权用户命名空间，提示用户 `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox`，不以 `--no-sandbox` 绕过。

## 9. 实施顺序

1. guest 与模板：cell.env 双 SHA、arch.sh、install-pi.sh、模板、up.sh 的 `--vm-type`、verify 脚本实例名参数化，加测试。
2. 桌面：platform.cjs 与 host-tools.json、downloader.cjs、setup/runtime/directory-store 接入、渲染器文案，加测试。
3. 打包与 CI：package.cjs 平台分支、check.yml 矩阵、linux-live.yml。
4. 文档与 CHANGELOG。
5. macOS 回归与 linux-live 首次运行，修正暴露的问题。
