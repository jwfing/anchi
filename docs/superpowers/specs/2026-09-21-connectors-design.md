# Google Drive / Notion / Slack 连接器设计

日期：2026-09-21。状态：已实施。

> 修订（2026-09-21，实施后）：维护者决定把默认授权改为「连接即持续授权」——每个主体（四个 connector 与 `inference`）有 `auto`/`ask` 模式，默认 `auto` 对读、写与模型调用都自动签发一次性授权，`ask` 才逐次审批。下文中「写入永远逐条审批」「读规则 allow/deny」等表述为原设计，实际行为以 [SECURITY.md](../../../SECURITY.md) 的「授权模式」一节与 `services/policy.py` 为准；修订绑定、每日上限、账本与审批页展示不变。

## 1. 目标与非目标

目标：让 cell 内的 agent 能通过可信 connector 读写 Google Drive、Notion 与 Slack，安全边界与 Gmail 相同：凭证只在 VM 凭证库，agent 只能经 Unix socket 调用结构化操作，每个 connector 是独立 UID、独立 socket、独立出口；读取受按 connector 的持续只读规则或逐次审批控制，写入永远逐条审批、冻结完整内容、一次性消费、结果不明不重试。同时把 Gmail 迁到同一套声明式注册表上，后续新增 connector 只需一个 handler 文件加一条注册。

非目标（本期）：删除类操作；Slack 私信与用户令牌；Notion 数据库属性更新与公开 OAuth 集成；Slack OAuth（其回调必须 HTTPS，桌面回环流程不可行）；任务级授权；附件与二进制内容；多账户。

## 2. 已确认的决策

| 决策 | 结果 |
|---|---|
| 操作范围 | 三个 connector 都支持读与写；写包含新建与追加/更新，不含删除 |
| 凭证进入方式 | Drive 走独立的 Google PKCE 授权，令牌与 Gmail 分开存；Notion 内部集成令牌、Slack bot 令牌由主进程独立小窗口输入，经 stdin 进 VM 加密库 |
| Drive scope | `https://www.googleapis.com/auth/drive.readonly` + `https://www.googleapis.com/auth/drive.file`：读全部，新建任意位置，只能更新本应用创建的文件 |
| 代码组织 | `services/connectors.py` 声明式注册表驱动服务、出口、策略、凭证范围、Pi 工具与桌面卡片；Gmail 一并迁入 |
| 写路径 | 复用 policy 的 authorize/consume；更新类操作绑定目标当前修订；每个 connector 独立写账本；UNKNOWN 不重放；每日 200 次写上限 |
| 真机验证 | 无账户部分由 VM 内 `check-connectors.py` 与 `linux-live` 覆盖；真实账户读写由维护者用自己的账户完成并批准 |

## 3. 注册表

`services/connectors.py` 是唯一来源，形如：

```python
CONNECTORS = {
    'gmail':  Connector(user='secure-gmail',  hosts=('gmail.googleapis.com',), credential='google:gmail',
                        module='gmail',  ops={'gmail.status': READ, 'gmail.list': READ, 'gmail.read': READ}),
    'drive':  Connector(user='secure-drive',  hosts=('www.googleapis.com',),  credential='google:drive',
                        module='drive',  ops={'drive.status': READ, 'drive.search': READ, 'drive.read': READ,
                                              'drive.create': WRITE, 'drive.update': WRITE}),
    'notion': Connector(user='secure-notion', hosts=('api.notion.com',),      credential='token:notion',
                        module='notion', ops={'notion.status': READ, 'notion.search': READ, 'notion.read': READ,
                                              'notion.create_page': WRITE, 'notion.append': WRITE}),
    'slack':  Connector(user='secure-slack',  hosts=('slack.com',),           credential='token:slack',
                        module='slack',  ops={'slack.status': READ, 'slack.channels': READ, 'slack.history': READ,
                                              'slack.post': WRITE}),
}
```

每个 connector 的 socket 固定为 `/run/secure-<id>/api.sock`，状态目录 `/var/lib/secure-<id>`，写账本 `/var/lib/secure-<id>/writes.sqlite3`。`status` 操作不经 policy，只返回连接元数据（是否已连接、账户标签、scope 或权限说明），不含令牌。

派生关系：

- `server.py`：模式集合、handler 与允许调用的 UID 由注册表给出；auth 服务按调用方 UID 决定可请求的凭证操作（`gmail`→`access_token:gmail`，`drive`→`access_token:drive`，`notion`→`token:notion`，`slack`→`token:slack`）。
- `network_rules.py`：每个 connector 的用户只允许到其 `hosts` 解析出的公开 IP 的 TCP 443；`secure-inference` 与 policy 的规则不变。
- `policy.normalize`：操作名必须在调用方 connector 的 `ops` 里，参数由 handler 模块的 `validate(op, params)` 校验；操作种类决定能否被持续只读规则自动放行。
- `guest/install-gmail.sh`（保留文件名以稳定部署路径）：按注册表创建用户、组成员、tmpfiles 目录；`cell-run` 只读绑定每个 connector 的 socket 目录。
- Pi 与桌面各有一份轻量描述（`pi/connectors.mjs`、`desktop/src/shared/connectors.cjs`），由注册表一致性测试保证与 Python 注册表同名同操作。

## 4. 凭证与授权

### 4.1 凭证库

`vault.NAMES` 新增 `drive-tokens.json`、`drive-pending.json`、`notion.json`、`slack.json`。`auth.py` 按 connector 索引：

- Google 类：`begin(connector, redirect_uri)`、`complete(connector, value)`、`access_token(connector)`、`disconnect(connector)`。scope 集合来自注册表：gmail `{gmail.readonly}`，drive `{drive.readonly, drive.file}`。兑换结果的 scope 必须恰好等于请求集合，否则拒绝并不保存。刷新令牌失效时置 `reauth_required`，与 Gmail 现有行为一致。每次成功授权生成新的账户 generation。
- 静态令牌类：`import_token(connector, value)` 校验格式（Notion 以 `ntn_` 或 `secret_` 开头、长度 40 到 200；Slack 以 `xoxb-` 开头、长度 40 到 200），写入 `{'token': ..., 'generation': uuid, 'imported_at': ...}`。导入不做网络请求，因为 auth 服务的出口只有 Google。
- `status()` 返回按 connector 的 `{connected, reauth_required, account, scope_text, revocation_pending}`。

### 4.2 账户标签探测

新增 `services/connector_admin.py <connector> probe|disconnect`，root 入口降权到该 connector 的用户后：`probe` 调 Slack `auth.test` 或 Notion `GET /v1/users/me`，把团队名或 workspace 名写回凭证条目的 `account` 字段（Drive 用 `GET /drive/v3/about?fields=user` 取邮箱）；`disconnect` 对 Slack 调 `auth.revoke` 后删除条目，对 Notion 只删除条目并返回 `remote_revoked: false, manual_step: 'remove the integration in Notion settings'`，对 Drive 走现有 Google revoke。桌面在导入或授权成功后立刻调用 `probe`，失败不影响已保存的凭证，只显示「未验证」。

### 4.3 桌面侧

- `oauth.cjs` 的 `validateAuthorization(flow, redirect, scopes)` 接受期望 scope 集合；`runtime.auth(action, value, connector)` 把 connector 作为 admin CLI 参数。
- 令牌输入窗：主进程创建独立 `BrowserWindow`（`anchi://app/token.html`，无 Node、contextIsolation、sandbox），页面只有一个密码框与说明文字，通过专用 IPC `desktop:token` 把令牌交给主进程，主进程直接送 `admin.py import-token <connector>` 的 stdin，随后销毁窗口。令牌不进入主页面、不进入活动记录、不进入日志。
- 断开时对 Gmail 保持现有语义（停止 Pi、撤销持续读取、Google revoke）；其他 connector 撤销其持续读取规则并调用 `connector_admin disconnect`。

## 5. 操作定义

所有 ID 参数只接受 `[A-Za-z0-9_-]{1,128}`；查询字符串 ≤ 512 字符且无控制字符；正文 UTF-8 ≤ 48 000 字节；`limit` 为整数并受下表上限约束。读结果统一带 `untrusted_content: true`，正文超过 40 000 字节截断并置 `truncated: true`。

### 5.1 Drive

| 操作 | 种类 | 参数 | 上游调用 |
|---|---|---|---|
| `drive.search` | read | `query`（Drive `q` 表达式或纯文本，纯文本转为 `fullText contains`）、`limit` ≤ 10 | `GET /drive/v3/files?q=…&pageSize=…&fields=files(id,name,mimeType,modifiedTime,size,parents)` |
| `drive.read` | read | `file_id` | 先 `GET /drive/v3/files/{id}?fields=id,name,mimeType,size,headRevisionId`；Google 文档用 `GET /drive/v3/files/{id}/export?mimeType=text/plain`，`text/*`、`application/json`、`text/markdown` 用 `GET /drive/v3/files/{id}?alt=media`；其他类型返回 `UNSUPPORTED_MIME_TYPE`；媒体响应上限 2 MB |
| `drive.create` | write | `parent_id`（可为 `root`）、`name` ≤ 255、`mime_type` ∈ {`text/plain`, `text/markdown`, `application/vnd.google-apps.document`}、`text` | `POST /upload/drive/v3/files?uploadType=multipart`，Google 文档以 `text/plain` 上传并转换 |
| `drive.update` | write | `file_id`、`expected_revision`、`text` | 执行前 `GET …?fields=headRevisionId,mimeType,name`，不等于 `expected_revision` 即 `TARGET_CHANGED`；`PATCH /upload/drive/v3/files/{id}?uploadType=media` |

准备 `drive.update` 时 handler 先读取目标元数据，把 `name`、`mime_type`、`headRevisionId` 填进规范化动作，审批页据此显示「将更新《name》（修订 R）」。受 `drive.file` scope 限制，只有本应用创建的文件能更新，其他文件由 Google 返回 403，映射为 `TARGET_NOT_WRITABLE`。

### 5.2 Notion

请求头 `Notion-Version: 2022-06-28`、`Authorization: Bearer`。

| 操作 | 种类 | 参数 | 上游调用 |
|---|---|---|---|
| `notion.search` | read | `query`、`limit` ≤ 10 | `POST /v1/search`，返回 id、类型、标题、最近编辑时间 |
| `notion.read` | read | `page_id` | `GET /v1/pages/{id}` 取标题与 `last_edited_time`；`GET /v1/blocks/{id}/children?page_size=100` 最多翻 5 页，把段落、标题、列表、引用、代码块的 rich_text 拼成纯文本 |
| `notion.create_page` | write | `parent_page_id`、`title` ≤ 200、`paragraphs`（字符串数组，合计 ≤ 48 000 字节，每段 ≤ 2 000 字符） | `POST /v1/pages`，children 为 paragraph 块 |
| `notion.append` | write | `page_id`、`expected_last_edited`、`paragraphs` | 执行前 `GET /v1/pages/{id}` 比较 `last_edited_time`；`PATCH /v1/blocks/{id}/children` |

### 5.3 Slack

| 操作 | 种类 | 参数 | 上游调用 |
|---|---|---|---|
| `slack.channels` | read | `limit` ≤ 200 | `GET /api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=…`，只返回 bot 已加入的频道 |
| `slack.history` | read | `channel`、`limit` ≤ 50、可选 `oldest`（Unix 秒） | `GET /api/conversations.history`，每条消息只保留 `ts`、`user`、`text`（≤ 4 000 字符）、`thread_ts` |
| `slack.post` | write | `channel`、`text` ≤ 4 000 字符、可选 `thread_ts` | `POST /api/chat.postMessage`，JSON 正文 |

Bot 令牌需要的 scope 写在界面与文档：`channels:read`、`channels:history`、`groups:read`、`groups:history`、`chat:write`。Slack 的 `ok: false` 响应按 `error` 字段映射为固定错误码（`not_in_channel` → `NOT_IN_CHANNEL`，`invalid_auth`/`token_revoked` → `REAUTH_REQUIRED`，其余 → `PROVIDER_REJECTED`），不回显原文。

## 6. 策略与写路径

### 6.1 规则

policy 数据库新增 `read_rules(connector TEXT PRIMARY KEY, allowed INTEGER NOT NULL)`；现有 `config.gmail_read` 在首次打开时迁入 `gmail` 行并保留列以兼容旧备份。`set_read(connector, allow)` 与现在一样提升 epoch 并把所有未消费授权置为 REVOKED。`policy_admin.py read <connector> allow|deny` 取代 `gmail-read`（保留 `gmail-read` 作为别名一个版本）。

`authorize` 的自动放行条件改为：操作种类为 read 且该 connector 的规则为 allow。write 操作在任何规则下都进入 PENDING，10 分钟内待审批，批准后签发 60 秒一次性 ticket，消费时再次核对摘要、账户 generation、epoch、boot ID。

### 6.2 写账本

从 `inference.py` 抽出 `services/ledger.py`：`Ledger(path).begin(request_id, digest)` → 已存在且摘要不同抛 `REQUEST_ID_CONFLICT`；SUCCEEDED 返回缓存；RUNNING/UNKNOWN/FAILED 抛 `REQUEST_ALREADY_<state>`；WAITING_APPROVAL 允许继续。`Ledger.finish(request_id, state, result|error)`。服务重启时 RUNNING 置为 UNKNOWN。每日上限：同一 connector 24 小时内不同 request_id 的写入 ≥ 200 时抛 `DAILY_WRITE_LIMIT`。`inference.py` 与 `pi_gateway.py` 改用同一模块，行为不变。

写操作流程：校验参数 → 更新类操作读取目标当前修订并填入动作 → `Ledger.begin` → `policy_client.require(action)`（未批准抛 `APPROVAL_REQUIRED:<id>`，账本记 WAITING_APPROVAL）→ 置 RUNNING → 更新类操作再次核对修订 → 单次上游调用，不重试 → SUCCEEDED 记录上游返回的对象 ID，或 FAILED（Denied）/ UNKNOWN（超时、断流、非 Denied 异常）。

### 6.3 审批展示

桌面 `approvalSummary` 对写操作显示：connector、账户标签、操作、目标（父目录或页面或频道名、目标文件名与修订）、正文全文（折叠前显示前 300 字），并在卡片顶部用醒目样式标注「这是一次写入」。读操作沿用现有摘要。

## 7. 服务、出口与 cell

- 新增 `systemd/secure-drive.{socket,service}`、`secure-notion.*`、`secure-slack.*`，硬化选项与 `secure-gmail` 相同，`InaccessiblePaths` 含凭证目录与 vault，`StateDirectory=secure-<id>`。
- `guest/install-gmail.sh`：用户、`secure-auth-clients` 与 `secure-policy-clients` 组成员、tmpfiles 行 `d /run/secure-<id> 0750 secure-<id> secure-cell-peer -`，从注册表生成而不是手写；`systemctl` 启停列表同样派生。
- `guest/cell-run`：新增 `--bind-ro=/run/secure-drive`、`/run/secure-notion`、`/run/secure-slack`。
- `services/common.py`：`google_json` 泛化为 `provider_json(connector, method, path, *, headers, body, content_type)`，主机来自注册表，路径必须匹配该 connector 声明的路径正则集合，其余保持：固定 IP 表、TLS 主机名校验、不跟随重定向、2 MB 上限、错误不回显。
- `network_rules.ROLES` 从注册表派生；`check-security.py` 的出口断言随之增加。

## 8. Pi 侧

- `pi/connectors.mjs`：每个操作一个工具定义（名称与操作名一致，如 `drive_search`），描述里写明数据去向与只读或写入性质，参数 schema 与 §5 上限一致。
- `agent.mjs` 在创建会话时对四个 connector 的 socket 调 `status`，只为 `connected: true` 的注册工具；不可达的 socket 视为未连接。写工具的描述明确「需要用户在独立审批中批准，可能等待数分钟」。
- `bridge.mjs` 的审批等待逻辑不变；写工具调用返回的 `APPROVAL_REQUIRED` 由工具层轮询等待，复用 `rpc` 的 150 秒超时与 pi 的工具超时。
- `codex_schema.TOOL_NAMES` 收录全部工具名；工具总数约 20，工具 schema 体积计入 44 KB 上下文上限，需在测试中断言全部工具的 schema 合计 ≤ 8 KB。

## 9. 桌面

- `desktop/src/shared/connectors.cjs`：`{ id, label, auth: 'google' | 'token', scopeText, dataText, tokenHint }` 四条。
- 权限页按描述渲染卡片：状态与账户标签、`需要重新认证` 提示、按钮组（Google：导入客户端 JSON、连接、取消、断开；令牌：输入令牌、断开）、持续只读允许与撤销。Gmail 卡片行为不变。
- controller 操作：`connector-status {connector}`、`connector-connect {connector}`、`connector-cancel {connector}`、`connector-import-token {connector}`、`connector-disconnect {connector}`、`connector-read {connector, mode}`；`connector` 必须是描述表内的 id。原 `gmail-*` 操作保留为别名一个版本，渲染器改用新名。
- 令牌窗口：`desktop/src/renderer/token.html` 与 `token.mjs`，只做输入与提交，无 agent 内容；`security.cjs` 的资源白名单与 IPC 来源校验覆盖该窗口。

## 10. 测试与验证

离线：

- 注册表一致性：Python 注册表、`pi/connectors.mjs`、`desktop/src/shared/connectors.cjs`、systemd 单元文件名、`install-gmail.sh` 的用户列表、`cell-run` 的绑定、`codex_schema.TOOL_NAMES` 五处同名同集。
- 每个 handler：参数校验拒绝越界；读操作在 policy 拒绝时不发网络请求；写操作未批准时账本为 WAITING_APPROVAL 且无网络请求；更新类修订不匹配抛 `TARGET_CHANGED` 且不写；上游 `ok: false` 与非 200 不回显原文；截断与大小上限。
- policy：write 操作在 read 规则为 allow 时仍返回 `ask`；`read_rules` 迁移保留 gmail 规则；`set_read` 撤销所有未消费授权。
- ledger：冲突、缓存、UNKNOWN 不重放、每日上限、重启恢复。
- auth：按 connector 分离的 Google 令牌与 scope 精确匹配；静态令牌格式校验；`status` 不含令牌。
- Pi：只为已连接 connector 注册工具；工具 schema 总体积上限。
- 桌面：卡片渲染、connector 参数白名单、令牌窗口 IPC 只接受来自该窗口的调用。

真机：VM 内 `check-connectors.py`（无账户）：三个新 socket 在 cell 可见、auth 与 policy 不可见、伪造操作与令牌导出被拒、各服务 UID 出口只允许其主机；`make verify-vm` 与 `linux-live` 自动包含。真实账户：维护者分别连接自己的 Drive、Notion、Slack，各做一次搜索、一次读取、一次新建与一次更新/追加/发送，并在独立审批中核对全文后批准；结果记入验证记录。

## 11. 风险与应对

- `drive.file` 限制更新范围：非本应用创建的文件更新会被 Google 拒绝，界面与工具描述都要说明。
- Notion API 版本演进：固定 `2022-06-28`，与数据源新模型无关；升级时只改一处常量。
- Slack 速率限制（Tier 3 约 50 次/分钟）与每日写上限叠加；被限流返回 `PROVIDER_RATE_LIMITED`，不重试。
- 更新类操作的修订核对与实际写入之间仍有毫秒级窗口，文档如实写出。
- 工具数量增加可能让模型误用写工具；写工具描述强调审批，且默认只为已连接 connector 注册。

## 12. 实施顺序

1. 注册表与 ledger 抽取：`connectors.py`、`ledger.py`、`server.py`/`network_rules`/`policy`/`install-gmail.sh`/`cell-run` 派生化，Gmail 行为不变，全部现有测试通过。
2. 凭证泛化：`auth.py` 按 connector、静态令牌导入、`connector_admin.py`、`admin.py` 参数化、桌面 `oauth.cjs`/`runtime.auth`/令牌窗口/描述表/权限页卡片。
3. Drive handler 与工具、systemd 单元、检查脚本。
4. Notion handler 与工具。
5. Slack handler 与工具。
6. 文档、CHANGELOG、验证记录；真实账户验证由维护者完成。
