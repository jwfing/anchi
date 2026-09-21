# 变更记录

格式参考 Keep a Changelog；版本号来自 `desktop/package.json`。

## Unreleased

### 新增
- 目录授权持续至撤销：授权时记录目录的设备号与 inode（目录计划 schema v2），应用启动时只恢复身份未变的目录；被移动、替换或不可访问的目录回到「未启用」并显示原因。
- 文件代理的删除和覆盖改为移入被授权目录下的隐藏 `.anchi-trash`，用户可找回，Agent 无法看到或访问。
- Gmail 刷新令牌失效时进入「需要重新认证」状态，不再重复请求 Google；桌面权限页显示该状态。
- 桌面活动记录落盘到 `activity.jsonl`（仅事件类型、时间与标识，不含聊天和审批正文）；活动页可读取 VM 内策略审计（`policy_admin.py audit`）。
- 审批页自动载入、导航徽标显示待审批数量；请求详情先展示结构化摘要（操作、账户、模型、工具、最近用户输入），完整 JSON 折叠可查。
- 首次设置显示模型认证到期时间与 VM 服务版本；guest 安装时写入 `/opt/secure-vm/installed.json`。
- `guest/cell.env` 成为 cell UID 映射、Node 与 Pi 版本的唯一来源；shell、Python、Pi 端及测试共同读取。
- 跨语言传输上限常量（`services/common.py`、`pi/limits.mjs`、`desktop/src/shared/protocol.cjs`）由测试保证一致。
- `make lint`：Ruff、shellcheck、Prettier（含 `pi/`）；CI 增加 shellcheck、macOS 未签名打包冒烟任务和 Dependabot。
- 新增测试：服务端 UID 与限速、`bridge.mjs` 审批等待与 UTF-8 分帧、`network_rules.refresh`、`setup_status`、多层 multipart 正文、目录恢复、活动日志、配置目录迁移等。

### 变更
- 模型认证到期后可直接在首次设置重新登录或导入，不再要求先断开 Pi；只有重建环境仍需断开。
- cell 与可信服务之间的 JSON 改为 UTF-8 传输，大小按 UTF-8 字节计，中文上下文容量约为之前的两倍。
- 文件代理改用首次设置安装的宿主 Python，而不是固定的系统 Python 路径。
- 渲染器合并连续事件的快照刷新，重绘时保持输入焦点；页面切换不再被长任务阻塞。
- 产品改名收尾：配置目录首次启动时从 `Qisuo` 迁移到 `Anchi`；发布变量接受 `ANCHI_*`（`QISUO_*` 仍可用）；开发版 Bundle ID 改为 `local.anchi.desktop`；npm 包名改为 `anchi-desktop`、`anchi-pi`。
- 应用版本由主进程注入页面，不再手写在 HTML 中。

### 已知未完成
- 任务级授权、多 agent 实例、Gmail 发送、会话压缩、旧 API-key 推理路径的去留、签名公证与自动更新。详见 README 能力表。
