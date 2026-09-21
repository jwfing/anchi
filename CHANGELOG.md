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

- Linux x86_64 客户端（实验性）：Lima + QEMU/KVM，单一 VM 模板列出 arm64 与 amd64 镜像并由 `up.sh` 显式选择驱动；首次设置按固定版本与 SHA-256 下载 Lima 与 Codex 到用户目录，QEMU 与 kvm 组权限以命令文本交由用户执行；新增 `platform.cjs`、`downloader.cjs`、`host-tools.json`、`guest/arch.sh`；产物 `Anchi-linux-x64.tar.gz`；`linux-live` 工作流在 KVM runner 上从零建 VM 并运行全部验收脚本。

- Google Drive、Notion、Slack 连接器：声明式注册表（Gmail 一并迁入）、按 connector 的持续只读规则、逐条审批且绑定目标修订的写入（新建、更新、追加、发消息）、独立写账本与每日上限、Notion/Slack 静态令牌经独立窗口导入、Pi 只为已连接 connector 注册工具、桌面按描述表渲染卡片、审批页写入横幅。

### 变更
- 审批机制改为按主体的授权模式：Gmail、Drive、Notion、Slack 与模型调用（`inference`）各有 `auto`/`ask` 模式，默认 `auto`（连接即持续授权，读写与模型调用由策略自动签发一次性授权并审计），`ask` 逐次审批。新增 `policy.sh rules` 与 `mode <主体> auto|ask`（`read`/`gmail-read` 保留为别名）；桌面卡片改为模式开关，恢复持续授权时弹出提示注入风险确认；首次设置页可切换模型调用模式。切换模式撤销所有未消费授权。
- 模型认证到期后可直接在首次设置重新登录或导入，不再要求先断开 Pi；只有重建环境仍需断开。
- cell 与可信服务之间的 JSON 改为 UTF-8 传输，大小按 UTF-8 字节计，中文上下文容量约为之前的两倍。
- 文件代理改用首次设置安装的宿主 Python，而不是固定的系统 Python 路径。
- 渲染器合并连续事件的快照刷新，重绘时保持输入焦点；页面切换不再被长任务阻塞。
- 产品改名收尾：配置目录首次启动时从 `Qisuo` 迁移到 `Anchi`；发布变量接受 `ANCHI_*`（`QISUO_*` 仍可用）；开发版 Bundle ID 改为 `local.anchi.desktop`；npm 包名改为 `anchi-desktop`、`anchi-pi`。
- 应用版本由主进程注入页面，不再手写在 HTML 中。

### 已知未完成
- 任务级授权、多 agent 实例、Gmail 发送、会话压缩、旧 API-key 推理路径的去留、签名公证与自动更新。详见 README 能力表。
