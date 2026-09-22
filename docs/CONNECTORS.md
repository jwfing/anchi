# 连接器：Google Drive、Notion、Slack（与 Gmail）

2026-09-21。四个 connector 都在 `services/connectors.py` 注册，各自独立 UID、独立 socket、独立出口；默认连接即持续授权（读写自动放行），每个 connector 可单独改为逐次审批。凭证只进入 VM 凭证库，cell 内的 agent 只能通过结构化操作调用。

## 授权准备

| Connector | 准备 | 应用内动作 |
|---|---|---|
| Gmail | 与之前相同：Google Cloud 项目启用 Gmail API，导入 Desktop OAuth 客户端 JSON | 「连接 Google」，scope 只读 |
| Google Drive | 同一 Google Cloud 项目启用 Drive API；OAuth 同意屏幕加入 `drive.readonly` 与 `drive.file` | 「连接 Google」，单独一次授权，令牌与 Gmail 分开存 |
| Notion | 打开 [app.notion.com/developers/connections](https://app.notion.com/developers/connections)（需为工作区 Owner）→ Internal connections → Create a new connection；在 Configuration 勾选读取、插入、更新内容并复制 Installation access token；在 Content access 或页面菜单「Connections」把测试页面共享给该连接 | 「输入 Notion 令牌」，在独立小窗口粘贴以 `ntn_` 开头的密钥 |
| Slack | api.slack.com 创建应用，Bot Token Scopes 加入 `channels:read`、`channels:history`、`groups:read`、`groups:history`、`chat:write`，安装到工作区，把 bot 邀请进需要访问的频道 | 「输入 Slack Bot 令牌」，粘贴以 `xoxb-` 开头的令牌 |

令牌粘贴窗口由主进程单独创建，只有一个密码框；令牌经 IPC 直达主进程，再经 stdin 进入 VM 加密库，不经过展示 agent 内容的页面，也不写入活动记录。导入后应用会以该 connector 自己的身份调用 `auth.test`、`users/me` 或 `about` 取回账户标签显示在卡片上；探测失败只影响标签。

## 授权模式

连接账户后该 connector 处于「持续授权」：读写都由策略按白名单自动签发一次性授权，不弹审批。卡片上的「改为逐次审批」把它切到 `ask`：之后每个操作都进入独立审批页，需要核对内容后批准；「恢复持续授权」会先弹出说明提示注入风险的确认框。模型调用有同样的开关，在首次设置页第 4 步。切换任一模式都会撤销所有未消费的授权。终端等价命令：

```bash
bash scripts/policy.sh rules                 # 查看每个主体当前模式
bash scripts/policy.sh mode drive ask        # Drive 改为逐次审批
bash scripts/policy.sh mode inference auto   # 模型调用恢复持续授权
```

## 读与写

| Connector | 读 | 写 |
|---|---|---|
| Drive | `drive_search`（名称或全文，≤10）、`drive_read`（Google 文档导出文本或 text 类文件，≤40 KB） | `drive_create`（指定文件夹新建文本或 Google 文档）、`drive_update`（更新本应用创建的文件，绑定当前修订） |
| Notion | `notion_search`（≤10）、`notion_read`（页面块拼成文本，≤40 KB） | `notion_create_page`（父页面下新建）、`notion_append`（追加段落，绑定当前编辑时间） |
| Slack | `slack_channels`（bot 已加入的频道）、`slack_history`（≤50 条） | `slack_post`（发消息，可选线程） |

写入正文上限 48 KB；每个 connector 每天最多 200 次写入；更新类操作无论哪种模式都绑定目标修订。Pi 只为「已连接」的 connector 注册工具。

## 审批页如何核对写入（逐次审批模式）

写入请求在审批页带有橙色横幅「这是一次写入」，摘要显示：connector 账户、操作、目标（文件名与修订、页面与编辑时间、频道与线程）、正文全文。批准后立即执行一次；更新类操作在执行前再次核对目标修订，变化则以 `TARGET_CHANGED` 失败且不重试。结果不明（超时、断流）记为 UNKNOWN，同一请求不会自动重放。

## 断开

- Gmail、Drive：撤销持续读取，删除本机令牌，尝试 Google 远端撤销；失败会显示待重试。
- Slack：撤销持续读取，调用 `auth.revoke` 使令牌失效，删除本机令牌。
- Notion：撤销持续读取并删除本机令牌；Notion 没有远端撤销接口，请到 Notion 设置中移除该集成。

## 数据去向与限制

- 读取到的邮件、文件、页面和消息可能进入 agent 上下文与云模型；凭证隔离不等于数据不出本机。
- Drive 使用 `drive.file` scope，只能更新本应用创建的文件；其他文件的更新会被 Google 拒绝并显示为 `TARGET_NOT_WRITABLE`。
- 修订核对与实际写入之间仍有毫秒级窗口。
- Slack bot 只能读取它已加入的频道；私信、用户令牌与 OAuth 暂不支持。
- Notion API 版本固定为 `2022-06-28`。

## 命令行

```bash
bash scripts/policy.sh read drive allow      # 持续只读许可，deny 撤销并作废所有待消费授权
bash scripts/policy.sh pending               # 待审批
limactl shell secure-vm -- sudo /usr/bin/python3 /opt/secure-vm/services/connector_admin.py slack probe
```

真实账户验证需要维护者用自己的账户完成：连接、搜索、读取、新建、更新或追加或发送，并在独立审批中核对全文后批准。
