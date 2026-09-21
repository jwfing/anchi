# Drive / Notion / Slack 连接器验证记录

日期：2026-09-21。分支 `feat/connectors`，对应 [设计](../superpowers/specs/2026-09-21-connectors-design.md) 与 [实施计划](../superpowers/plans/2026-09-21-connectors.md)。

## 离线

- `make check PYTHON=.venv/bin/python`：Ruff、shellcheck、Prettier 通过；桌面 65、Pi 14、Python 115 项测试通过。
- 新增测试覆盖：注册表形状与派生（服务模式、凭证范围、出口角色、读规则迁移）、账本状态机、允许路径与错误映射的上游传输、读写执行流程（未批准不执行、UNKNOWN 不重放、准备阶段字段进入审批对象）、按 connector 的 Google 令牌与精确 scope、静态令牌格式、connector_admin 探测与断开、三个 handler 的参数校验、请求形态、修订绑定与响应裁剪、部署一致性（单元文件、cell 绑定、安装脚本、检查脚本）、Pi 工具目录体积与动态注册、桌面描述表、connector 操作路由、卡片与写入横幅、令牌窗口 IPC 来源校验。

## macOS 真机（现有 secure-vm）

- `bash scripts/install-pi.sh`：新建 `secure-drive`、`secure-notion`、`secure-slack` 用户与 socket，tmpfiles 与单元由注册表生成；三个 socket active。
- `admin.py status` 返回按 connector 嵌套的状态；`connector_admin.py slack probe` 在无令牌时返回 `NOT_CONNECTED`；`policy.sh read drive allow|deny` 往返正常。
- `make verify-vm`：114 项全部通过（原 77 项加 `check-connectors.py` 的 18 项与 `check-security.py` 新增的每 connector 出口与凭证范围检查）。
- `check-pi-rpc.py`：Pi 启动时只为已连接的 Gmail 注册工具，取消、恢复、跨进程恢复通过；合成待审批已拒绝，未调用模型。
- `verify-files.cjs`：通过。

## GitHub Actions

- `linux-live` [35649586100](https://github.com/jwfing/anchi/actions/runs/35649586100)：x86_64 KVM runner 从零建 VM，安装含三个新 connector 的可信服务与 Pi，引导检查、重试保留、114 项隔离与服务检查全部通过，耗时约 3 分钟。
- `Source checks` [35649586012](https://github.com/jwfing/anchi/actions/runs/35649586012)：macOS 与 Ubuntu 离线检查通过。

## 未覆盖，需维护者完成

真实账户读写没有在本次验证中执行，需要维护者用自己的账户逐个完成并记录：

1. Drive：在 Google Cloud 项目启用 Drive API 与两个 scope → 应用内「连接 Google」→ `drive_search` 一次、`drive_read` 一次 → `drive_create` 新建一个文本文件并在审批页核对全文后批准 → `drive_update` 更新该文件并核对修订号 → 断开。
2. Notion：创建内部集成并共享一个测试页面 → 「输入 Notion 令牌」→ 搜索、读取 → 在测试页面下新建页面、向测试页面追加段落，各自审批 → 断开并到 Notion 设置移除集成。
3. Slack：创建应用、五个 bot scope、安装并邀请 bot 进测试频道 → 「输入 Slack Bot 令牌」→ 列频道、读历史 → 向测试频道发一条消息并审批 → 断开（`auth.revoke`）。
4. 桌面图形界面走查：令牌窗口输入与取消、卡片状态刷新、审批页写入横幅与正文。
