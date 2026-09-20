> 历史 PoC 记录：部分构建路径和完成状态已经过时。当前入口以根 README 与桌面说明为准。

# Secure VM — 本地隔离原型

桌面开发版已加入：双击 `artifacts/desktop/Qisuo-darwin-arm64/Qisuo.app`，或在 `desktop/` 执行 `npm start`。支持真实 Pi 通信、独立审批和原生目录选择；目录目前仅保存为待生效计划。使用说明与边界见 [桌面应用](../DESKTOP_APP.md)。

产品规划见 [MVP 产品与 UX](../MVP_PRODUCT_UX.md)。可点击的 [交互原型](../../prototype/index.html) 使用模拟数据，覆盖安装、目录权限、Gmail 连接、任务审批与撤销；直接用浏览器打开即可，不连接真实账户或 VM。

当前包含 Apple Silicon macOS 上的 Lima/VZ Linux VM、systemd-nspawn runtime cell、只读 Gmail 连接器，以及受限邮件工作流和推理网关。架构背景见 [设计文档](../../SECURE_VM_DESIGN.md)。

M3 IPC 和 Gmail 只读接入已验证，用户已完成 OAuth，后续 harness 也成功采集 3 封真实邮件。使用步骤见 [Gmail 接入说明](../GMAIL_SETUP.md)。

M5/M6/M7 的当前 MVP 安全基础已补齐：凭证静态加密、独立一次性审批、按服务 UID 的内核出口控制。操作方法与限制见 [安全基础说明](../SECURITY_FOUNDATION.md)。

M8 已部署真实 pi 0.85.1 SDK agent，使用 Codex 订阅认证，经独立审批网关成功完成真实模型与 bash/write/read 工具循环。多轮聊天运行 `python3 scripts/pi-chat.py`，支持取消和恢复，见 [聊天与 RPC](../PI_CHAT.md)。认证与审批见 [Pi agent](../PI_AGENT.md)。旧受限邮件工作流及 M9 记录原型仍保留，见 [旧工作流说明](../AGENT_WORKFLOW.md)。

2026-09-18 已在本机创建并启动 `secure-vm`，24 项 cell 隔离检查全部通过；已核对外层 cgroup 限额和无宿主共享挂载。详细证据及验证边界见 [首次验收记录](../VALIDATION-2026-09-18.md)。VM 保持运行，cell 在每条命令退出后结束。

## 运行

```bash
brew install lima
bash scripts/up.sh
python3 scripts/vault.py init
bash scripts/verify.sh
bash scripts/cell.sh /usr/bin/id
bash scripts/cell.sh /usr/bin/python3 -c 'print("hello from cell")'
```

`up.sh` 创建专用 `secure-vm` 实例，已有实例则启动并更新 guest 脚本。它不会自动把修改后的 YAML 应用到已有 VM；变更资源或 VM 配置需另行检查并显式应用。首次下载 Ubuntu 镜像、安装软件及构建 Debian rootfs 需要联网。Ubuntu 镜像固定 URL 与 SHA-256；Debian 软件包经过发行版签名校验，但包版本尚未固定到 snapshot，因此不是逐字节可复现构建。

所有脚本均从 macOS 可信管理端运行；`cell.sh` 经 Lima 的管理用户执行 guest sudo，不能把该入口、Lima SSH 密钥或管理用户交给 agent。邮件工作流只在 cell 内运行。

停止 VM：

```bash
limactl stop secure-vm
```

## 已选择的边界

- VM：4 vCPU、4 GiB 内存、30 GiB 稀疏磁盘，Ubuntu 24.04 arm64。
- 不挂载宿主目录；不转发 SSH agent 或应用端口；不安装 containerd。
- Cell：Debian bookworm，普通用户 `agent`，内部 UID/GID 1000。
- User namespace：内部 0–65535 映射到 guest host 的 524288–589823；agent 对应 525288。
- 独立网络 namespace，无 veth 或外部网卡；cell 只能看到 loopback。
- 只读基础 rootfs；唯一持久可写目录 `/workspace`；两个 64 MiB 临时目录。
- 进程无 capabilities，启用 no-new-privileges 与 syscall 过滤。
- 仅允许 AF_UNIX、AF_INET、AF_INET6、AF_NETLINK，额外禁止 vsock 和 packet socket 旁路。
- Cell 的 systemd 单元限制 1 GiB 内存、禁止 swap、128 个 tasks、最多两个 CPU 的配额。
- 固定单元名限制一次运行一个 cell；每次调用使用新的进程/网络 namespace，工作区保持。

## 文件布局

| 文件 | 用途 |
|---|---|
| `lima/secure-vm.yaml` | VM 配置、镜像校验和、基础软件安装 |
| `guest/bootstrap.sh` | 构建 rootfs、设置 UID 映射与工作区 |
| `guest/cell-run` | 可信管理侧启动器；参数只能选择 cell 内命令 |
| `guest/check-cell.py` | 在真实 cell 中执行隔离验收 |
| `scripts/up.sh` | 创建/启动 VM 并显式复制 guest 文件 |
| `scripts/cell.sh` | 在 cell 中执行命令 |
| `scripts/verify.sh` | 运行隔离测试 |

## 当前限制

目前是只读 Gmail 与受限邮件处理原型，pi 已支持本地工具规划及只读 Gmail 工具；尚无发信或浏览器。Guest 管理环境仍可联网，不能把它当作 agent 执行环境。已实现凭证文件加密和服务出口 ACL；尚无整盘加密、磁盘配额或完整备份恢复。HTTP 路径/正文控制仍依赖可信网关，内核 ACL 只能限制 IP/端口。

容器与 guest host 共享 Linux 内核，外层 VM 隔离 macOS；不能把容器测试通过理解为内核逃逸防护已经获得证明。VM 管理员是可信主体。

第一轮验收关注实际 UID 映射、无 capabilities、只读根目录、工作区写入、宿主文件不可见、IPv4/IPv6 TCP/UDP 无出口。新增 Gmail socket 使用 SO_PEERCRED 验证映射后的 UID，原有隔离检查仍全部通过。

## 参考

- [Lima VM types](https://lima-vm.io/docs/config/vmtype/)
- [Lima filesystem mounts](https://lima-vm.io/docs/config/mount/)
- [systemd-nspawn](https://www.freedesktop.org/software/systemd/man/latest/systemd-nspawn.html)
