# M1/M2 首次本机验收

日期：2026-09-18。范围：本地 VM 与按需执行的 runtime cell；不包含 Gmail、审批、凭证服务或 IPC broker。

## 环境与实际操作

- 宿主：macOS 26.6.2，arm64。
- 新安装 Lima 2.2.0；创建专用 `secure-vm`，VZ 后端。
- Guest：Ubuntu 24.04，Linux 6.8.0-134-generic，systemd 255.4-1ubuntu8.17。
- Ubuntu 镜像 SHA-256：`7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc`。
- Cell：Debian bookworm minbase，含 Python 3 与 iproute2。
- debootstrap 使用 `--force-check-gpg`；日志确认 Release 签名有效。
- `up.sh` 已再次执行成功，复用现有 rootfs 并更新脚本。

## 验证结果

配置经 `limactl validate` 校验；shell 与 Python 文件经过语法检查。

在真实 cell 内执行以下命令，退出码 0，JSON 顶层 `passed: true`，24 项全部通过：

```bash
limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run \
  /usr/bin/python3 /opt/secure-vm/check-cell.py
```

覆盖范围：

- UID/GID 都为 1000，`uid_map` 为 `0 524288 65536`。
- Effective 和 bounding capabilities 均为空；no-new-privileges 和 seccomp 生效。
- Cell 无外层 canary、macOS `/Users`、Docker socket、宿主 systemd private socket。
- 根挂载为只读；workspace 可写。
- 网络仅有 loopback；不能创建新网络设备。
- 无法创建 AF_VSOCK 和 AF_PACKET socket。
- TCP 443 和 UDP 53 无法访问公网 IPv4、VM 网关测试地址、元数据地址和公网 IPv6；测试要求明确的路由/权限错误，超时不算通过。

## Guest host 侧核对

短暂运行 cell 时，systemd 返回：

```text
ControlGroup=/system.slice/secure-cell.service
CPUQuotaPerSecUSec=2s
MemoryMax=1073741824
MemorySwapMax=0
TasksMax=128
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX
ActiveState=active
```

`findmnt -rn -t virtiofs,9p,fuse.sshfs` 无结果（退出码 1），未发现上述宿主共享挂载。Lima 启动日志确认除管理 SSH 外，TCP/UDP 应用端口转发关闭。

文件所有权实测：

```text
524288:524288 755 /var/lib/secure-vm/rootfs
525288:525288 700 /var/lib/secure-vm/workspace
0:0 600 /var/lib/secure-vm-host-only/canary
```

## 尚未验证或实现

- 内核逃逸、完整攻击面审计、所有 syscall 拒绝行为。
- OOM/进程洪泛压力测试；目前仅核对实际生效配置。
- VM 重启/快照恢复、磁盘填满、持久化故障和崩溃恢复。
- OS 更新策略与固定包版本的可复现构建；发行版软件包随镜像源更新。
- IPC/审批/凭证/连接器/推理网关及相应负向测试。

此记录证明本轮有限测试的结果，不构成可安全处理真实主邮箱或秘密数据的完整评估。下一步为 M3：只暴露一个受限 Unix socket，在 cell 外校验内核提供的调用身份。
