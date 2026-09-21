# Gmail 只读接入

> Gmail 现在是注册表中的一个 connector；Drive、Notion、Slack 的接入与共同的读写规则见 [连接器](CONNECTORS.md)。

> 本文中的测试数量与验证结果为当日记录；当前以 `make check` 的输出为准。

当前代码已经部署到 `secure-vm`，本地策略和服务边界测试通过。用户已完成 Google OAuth 并读取 3 封邮件，后续 harness 也已实际采集到 3 封近期邮件。

## 1. 准备 Google OAuth 应用

需要启用 Gmail API 的 Google Cloud 项目，并下载 **Desktop app（桌面应用）** 类型的 OAuth client JSON。不能使用 service account JSON，也不要把密钥粘贴到聊天里。

若尚未配置：

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 选择或创建用于这个实验的项目。
2. 在 API Library 启用 Gmail API。
3. 在 Google Auth Platform 配置应用信息、受众和测试用户；测试阶段把你要连接的 Gmail 地址加入测试用户。
4. 创建 Desktop app OAuth client，下载 JSON，保存在项目外的私有目录。

应用只请求 `https://www.googleapis.com/auth/gmail.readonly`，不请求发送、删除或修改权限。该 scope 允许阅读整个邮箱；当前原型尚无按邮件发送人或文件夹进一步限制授权的策略。

Google 的桌面 OAuth 支持 loopback redirect 和 PKCE；本实现将 browser callback 绑定到 macOS 的 `127.0.0.1` 随机端口。[桌面 OAuth 文档](https://developers.google.com/identity/protocols/oauth2/native-app)

External/Testing 应用请求 Gmail 等用户数据权限时，refresh token 通常 7 天过期，需要重新授权；Workspace 管理策略也可能影响连接。[Google OAuth 生命周期](https://developers.google.com/identity/protocols/oauth2)

## 2. 授权

先执行 `python3 scripts/vault.py init`；之后每次 VM 重启用 `python3 scripts/vault.py unlock` 解锁，再在项目根目录运行：

```bash
python3 scripts/gmail-login.py --client /absolute/path/to/desktop-client.json
```

浏览器会打开 Google 授权页面，由你选择账户并同意只读权限。终端等待最多约 10 分钟。已导入 client 时，重新登录只需：

```bash
python3 scripts/gmail-login.py
```

流程中：

- Client 配置通过 SSH stdin 导入 VM，不出现在 shell 参数或日志中。
- VM 内生成 PKCE verifier 和 OAuth state，verifier 不返回宿主。
- macOS 本地回调校验 state、Host 和路径，再把 code 通过 SSH stdin 传给 guest 管理命令。
- VM 兑换并保存 token。access/refresh token 不返回 macOS 或 cell。
- 返回的 scope 必须恰好为 gmail.readonly；更宽的既有授权会被拒绝。建议使用本实验专用 OAuth client。

状态检查：

```bash
python3 scripts/gmail-login.py --status
bash scripts/gmail.sh status
```

`vault_unlocked` 表示凭证库是否已解锁。`connected` 表示本地存有授权材料，不保证 token 尚未被 Google 撤销。刷新失败并被 Google 判定为授权无效时，`reauth_required` 变为 true，服务停止请求 Google，需重新登录。实际读取才能验证外部授权有效。

全新安装默认逐次审批；若希望沿用已授权的邮箱只读访问，在可信终端运行 `bash scripts/policy.sh gmail-read allow`。当前已有授权在迁移时保留此规则。

## 3. 从 cell 读取

```bash
bash scripts/gmail.sh list --query 'in:inbox newer_than:7d' --limit 3
bash scripts/gmail.sh read MESSAGE_ID
```

`list` 返回邮件 ID；`read` 返回有限邮件头、snippet 和纯文本正文。暂不下载附件或输出 HTML 正文。单次 list 最多 10 条，read 正文有长度上限。

Gmail API 的 list 和 get 是两个不同接口。[List 文档](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)、[Get 文档](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)

第一次实际测试建议仅列出 1–3 封近期邮件，再按指定 ID 阅读。邮件输出标为不可信内容；不要将邮件中的指令作为管理命令执行。

## 4. 实际边界

```text
cell UID 1000（guest host 视角 525288）
  → /run/secure-gmail/api.sock
  → secure-gmail：校验 SO_PEERCRED + 固定只读操作
  → /run/secure-auth/token.sock
  → secure-auth：仅向 secure-gmail 返回 Google access token 与账户 generation
  → secure-policy：校验精确动作，签发并原子消费一次性授权
  → secure-gmail：只向固定 Google API 发起 HTTPS GET
```

Cell 只读挂载 Gmail 与 inference socket 目录；不能看到 credential socket 或存储。修改 CLI 不会获得其他 RPC 权限。服务不接受任意 URL、账户、HTTP header 或客户端声称的角色。

这版合并了 connector 业务逻辑和 Gmail 执行网关，由独立 secure-policy 做确定性授权。没有发信函数，也没有“聊天批准后可发送”的隐藏路径。

固定目标 HTTPS 实现拒绝私网 DNS 结果、固定解析后的 IP、校验 TLS 主机名、不跟随重定向、不采用环境代理。nftables 进一步按服务 UID 限制 provider IP/TCP443，其他出口拒绝。内核不能区分共享 IP 上的域名，HTTP 内容控制仍依赖可信网关。

## 5. 当前数据保护限制

- `/var/lib/secure-auth` 为 0700，凭证为 AES-256-GCM 密文、0600；主密钥留在 macOS 管理端，解锁时只放入 guest tmpfs。不是整盘加密；运行中的 guest root 仍可信。详见 [安全基础](SECURITY_FOUNDATION.md)。
- 邮件链接和 4–8 位数字仅做启发式遮盖，可能漏掉验证码、登录信息，也可能误删日期金额；不是完整 DLP。
- 已有可选推理网关，但默认关闭。`gmail.sh` 和 `agent.sh collect` 不调用模型；显式启用后的 `agent.sh summarize` 会向所选 provider 发送邮件摘录，见 [工作流说明](AGENT_WORKFLOW.md)。
- 未做账户级多租户隔离、完整 OAuth 端到端审计。断开已加入远端撤销和失败后的显式重试。

## 6. 断开

```bash
python3 scripts/gmail-login.py --disconnect
```

先停止本地 token 取用并清理待完成授权，再尝试 Google 远端撤销；保留 OAuth client 配置。失败返回 `revocation_pending:true`，再次运行同一命令重试。已经在途的请求不保证取消。

## 7. 已完成验证

- 当前共有 43 项单元测试，覆盖 OAuth、凭证加密、精确授权、防重放和任务状态。
- 12 项真实 cell Gmail 边界检查全部通过；另有 28 项 guest 安全基础集成检查。
- 原 24 项 cell 隔离测试在新增 socket 后再次全部通过。
- guest root 普通 RPC 连接分别被两个服务以 `CALLER_DENIED` 拒绝。这只验证 UID 检查，不表示能防可信管理员篡改服务或读取文件。
- 未授权读取返回 `NOT_CONNECTED`，未偷偷使用其他凭证。
- systemd 单元验证通过。

复测：

```bash
python3 -m unittest discover -s tests -v
bash scripts/verify.sh
```

真实授权和邮箱读取已完成；尚未单独验证真实 token 过期后的刷新、远端撤销与长时间运行恢复。
