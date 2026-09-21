# Linux 客户端验证记录

日期：2026-09-21。分支 `feat/linux-client`，对应 [设计](../superpowers/specs/2026-09-20-linux-client-design.md) 与 [实施计划](../superpowers/plans/2026-09-21-linux-client.md)。

## 离线

- `make check PYTHON=.venv/bin/python`：Ruff、shellcheck、Prettier 通过；桌面 59、Pi 11、Python 78 项测试通过。
- 新增离线测试：platform 表与手动步骤、host-tools 平台查找、downloader（哈希不匹配不落盘、重定向白名单、跳数与大小上限、`install_as` 与 `current` 链接）、Linux 首次设置前置条件与下载动作、平台系统目录黑名单、打包目标、Lima 模板双镜像与 `--vm-type`、`arch.sh` 映射与双 SHA。
- `limactl validate lima/secure-vm.yaml` 通过。

## GitHub Actions（x86_64 ubuntu runner，KVM）

`linux-live` 运行 [35632119410](https://github.com/jwfing/anchi/actions/runs/35632119410)，首次运行即通过，总耗时约 2 分 37 秒：

| 步骤 | 结果 | 耗时 |
|---|---|---|
| 启用 `/dev/kvm`（udev 规则） | 通过 | 1 秒内 |
| apt 安装 qemu-system-x86、qemu-utils | 通过 | 20 秒 |
| 用应用下载器安装 Lima 2.2.0（SHA-256 校验） | 通过 | 1 秒 |
| 从模板创建 amd64 VM、bootstrap、可信服务、Pi 安装 | 通过 | 1 分 39 秒 |
| `verify-onboarding.py`：新安装状态、随机主密钥解锁、合成令牌导入、cell 检查、Pi RPC 握手 | 通过 | 4 秒 |
| `verify-onboarding.py --retry`：重装后凭证、模型配置、工作区保留 | 通过 | 10 秒 |
| `verify.sh`：check-cell、check-gmail、check-inference、check-security | 77 项全部通过 | 7 秒 |

日志确认 guest 内安装的是 Node 22.23.2 的原生构建、映射 agent UID 525288、Lima 2.2.0。实例在工作流结束时删除，Lima 日志作为 artifact 上传。

`Source checks` 在 `macos-14` 与 `ubuntu-latest` 上均通过（运行 35632119417）。手动触发的运行 [35632520980](https://github.com/jwfing/anchi/actions/runs/35632520980) 另通过了两个打包冒烟：macOS 产出 `Anchi.app`，Ubuntu 产出 `Anchi-linux-x64.tar.gz` 并以 `sha256sum -c` 校验通过。

## macOS 回归

- `bash scripts/up.sh` 在现有 secure-vm 上重装 guest 脚本（含 `arch.sh`）与服务，正常。
- `make verify-vm`：77 项通过。`node desktop/scripts/verify-files.cjs`：通过。

## 未覆盖，需用户或额外条件

- Linux 图形界面走查（原生目录选择器、Codex 浏览器登录、审批页）：CI 只覆盖命令行路径。
- 发行版禁用非特权用户命名空间时的 `chrome-sandbox` 权限步骤：只在文档中说明。
- Linux 上真实 Codex 登录与真实模型调用：需要用户订阅与批准。
- Ubuntu 22.04 / Debian 12 的 QEMU 版本兼容：CI 使用 ubuntu-latest（24.04，QEMU 8.2）。
