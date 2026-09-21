# 差距修复验证记录

日期：2026-09-20，macOS arm64，现有 Lima secure-vm（Running）。对应 [CHANGELOG](../../CHANGELOG.md) Unreleased 条目。

## 离线

- `make check PYTHON=.venv/bin/python`：Ruff、shellcheck、Prettier（含 `pi/`）通过；桌面 44、Pi 11、Python 76 项测试通过。

## 部署

- `bash scripts/install-pi.sh` 在现有 VM 上重新安装 guest 脚本、可信服务和 Pi 适配器。`/opt/secure-vm/cell.env`（guest host 与 cell rootfs 各一份）、`/opt/secure-vm/installed.json`（runtime_version 0.1.1）就位；四个 socket、出口规则和刷新定时器均 active。
- `setup_status.py` 返回 `runtime_version`；`policy_admin.py audit` 返回审计元数据；`admin.py status` 返回 `reauth_required: false`。

## 真机检查

- `make verify-vm`：check-cell、check-gmail、check-inference、check-security 共 77 项全部通过，其中 check-cell 的 UID 映射断言与 check-gmail 的状态字段集合已按 cell.env 与 `reauth_required` 更新。
- `python3 scripts/check-pi-rpc.py`：真实 cell 内的 RPC 取消、忙碌拒绝、跨进程恢复、非法 session 拒绝通过；产生的合成待审批已用 `policy.sh deny` 拒绝，未调用模型。该路径同时经过了新的 UTF-8 传输与 bridge 分帧代码。
- `node desktop/scripts/verify-files.cjs`：真实 cell 与宿主文件代理往返、路径逃逸与隐藏目录拒绝、覆盖与删除进入 `.anchi-trash` 且对 Agent 不可见、只读拒绝、撤销后拒绝，全部通过；临时目录已清理。
- bootstrap.sh 全新安装分支：在现有 VM 内以独立路径 `/var/lib/secure-vm-fresh-test` 执行一次完整 bootstrap，debootstrap 成功，agent 用户 uid 1000，rootfs 经 nspawn 迁移为 524288 所有，工作区 525288，标记文件正确；测试树已删除，生产 rootfs 未受影响。宿主磁盘仅剩约 12 GB，因此未新建第二个 VM 跑 `verify-onboarding.py`。

## 桌面

- 从源码启动 Electron 35 秒无崩溃、无控制台错误；配置目录自动从 `Qisuo` 迁移到 `Anchi`，`activity.jsonl` 记录了迁移事件。
- 通过 DevTools 协议读取窗口 DOM：首次设置页显示注入的版本号、VM 服务版本 0.1.1、模型认证到期时间；点击「独立审批」自动从策略服务载入；活动页显示落盘事件并读取到 VM 审计行；权限页显示新文案与 Gmail 状态。

## 未覆盖，需用户或额外条件

- 真实模型调用与审批后继续（`check-pi-rpc.py --live`）：需要用户亲自批准，消耗订阅配额。
- 全新 Mac 安装、全新 VM 引导脚本整体（`verify-onboarding.py`）：需要磁盘空间或另一台机器。
- 原生目录选择器、目录授权重启恢复、Gmail 重新认证提示的图形界面走查：需要用户操作原生对话框。逻辑已由离线测试覆盖。
