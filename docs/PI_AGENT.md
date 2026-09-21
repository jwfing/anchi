# Pi agent：Codex 订阅认证与安全网关

> 本文中的测试数量与验证结果为当日记录；当前以 `make check` 的输出为准。

2026-09-18：已安装真实 pi 0.85.1，使用 pi 的 `createAgentSession` SDK 驱动模型与工具循环。Node.js 为官方 Linux arm64 22.23.2，安装包 SHA-256 已校验。运行模型为宿主 Codex 当前使用的 `gpt-6-astra`。本次以实际订阅 token 成功调用，不使用 Platform API key。

多轮对话现已支持：`python3 scripts/pi-chat.py`，详见 [聊天与 RPC 协议](PI_CHAT.md)。

## 运行与审批

项目根目录，终端 A：

```bash
# 已部署完成。需要重新安装/更新时：
bash scripts/install-pi.sh

# VM 重启后解锁，再同步宿主 Codex 的短期 access token：
python3 scripts/vault.py unlock
python3 scripts/pi-auth.py

# 提示词通过 stdin 进入 cell；输出为 JSONL 事件。
printf '%s' '用 bash 查看当前 uid，并简短说明运行环境。' | bash scripts/pi.sh
```

`pi-auth.py` 默认读取 `~/.codex/auth.json` 的 ChatGPT 登录缓存，模型默认取 `~/.codex/config.toml` 的 model；可用 `--model` 显式指定。它只输出 provider、model、过期时间和是否导入 refresh token，绝不输出 token。当前 `gpt-5.4-mini` 请求被此账号的服务拒绝；`gpt-6-astra` 已通过实际测试。

当输出 `approval_required`，在终端 B：

```bash
bash scripts/policy.sh pending
bash scripts/policy.sh show APPROVAL_ID
bash scripts/policy.sh approve APPROVAL_ID --digest EXACT_DIGEST
# 或 bash scripts/policy.sh deny APPROVAL_ID
```

审批页展示将发送的真实模型输入、工具 schema、模型及账户 generation。每个模型回合单独批准，包括工具返回结果后的下一回合。Pi 每 3 秒检查原请求是否被批准；批准后自动继续，不需要重新输入 prompt。cell 和模型都无权批准。

当前提供 SDK + JSONL 单次/RPC 入口及简易终端聊天，尚未接入官方 pi 交互 TUI。官方 CLI 同时安装在 cell 镜像中，但直接启动它不会自动拥有安全网关适配与凭证；使用 `scripts/pi.sh`。

## 实际链路

```text
macOS 管理端：已有 Codex ChatGPT 登录缓存
  └─ 只取 access_token / account_id，经 SSH stdin 导入
       └─ secure-auth：codex.json.enc（AES-GCM）

runtime cell UID 1000：pi SDK + bash/read/write/edit + Gmail 工具
  ├─ Gmail 工具 → secure-gmail → secure-policy → Gmail API
  └─ pi 自定义 provider → Unix socket → secure-inference
        ├─ 校验文本/函数 schema、固定模型与请求大小
        ├─ secure-auth：仅 inference UID 能取得 Codex access token
        ├─ secure-policy：精确内容批准、一次性消费
        ├─ SQLite：WAITING_APPROVAL → RUNNING → SUCCEEDED / FAILED / UNKNOWN
        └─ 固定 HTTPS POST https://chatgpt.com/backend-api/codex/responses
```

Pi 安装目录在只读 rootfs `/opt/secure-pi`，Node 在 `/opt/node`。工作目录 `/workspace`，会话保存在 `/workspace/.pi-secure/sessions/`，属于可读写的非可信工作数据。默认禁用扩展、skills、提示模板和 AGENTS.md 自动发现，避免意外加载工作区配置。模型只能声明本地 function tools，不允许 provider 托管浏览器、搜索、图片或文件 URL。

本地工具执行由真实 pi 完成，不经过模型网关“代做”。bash 可以在 cell 内运行普通程序；它仍无 capabilities、无外网路由、不能访问管理 SSH、policy socket 或凭证库。Gmail 工具包括 status/list/read，发送与修改仍不支持。`gmail_list` 默认约束最多 3 条；直接 connector 的可信上限仍为 10 条。

## 凭证生命周期

- 不复制宿主 refresh token/id token，不写入 cell 的 pi auth.json，也不把 bearer 放入环境变量或命令参数。
- VM 的加密文件只存订阅 access token、账户 ID、过期时间和 generation。
- access token 过期时失败关闭；在宿主 Codex 刷新或重新登录后执行 `python3 scripts/pi-auth.py` 同步。VM 不会与宿主争用 refresh token 的轮换。
- 同一账户重新同步保留 generation；切换账户生成新 generation，使旧批准不再匹配。
- `pi_status` 只返回 configured/provider/model，不包含账户或 token。configured 只表示配置存在，不能代替实际认证检查。
- 宿主已有登录缓存仍受宿主自身保护，本项目没有改变它的存储策略。VM 管理员仍是可信主体。

## 出口、配额与失败处理

`secure-inference` 的 nftables 出口新增 chatgpt.com 公开 IP/TCP443；原 api.openai.com 规则保留给旧 API-key 原型。该 UID 的所有允许规则位于最终 reject 之前，避免新 provider 被旧规则意外阻断。DNS 仍仅由 root 更新器解析，网关只连接固定数值 IP并校验 TLS 主机名。IP/端口 ACL 不能区分共享 IP 上的其他站点；业务路径限制由可信 transport 实现。

网关支持受限 SSE（含 response.done/response.completed）和完整 JSON；SSE 先在可信服务中缓冲，校验完成后交给 pi 官方 Responses 转换器，不逐 token 转发。禁止自动网络重试。超时、断流等不确定结果记录为 UNKNOWN，复用同一 request ID 不会再次执行。相同 ID 内容变更会被拒绝。

目前限制：每次 pi 运行最多 8 次模型回合（cell 侧便利限制），每个 VM 24 小时最多 50 个不同 Codex 请求（可信网关强制，包括失败/待审批）；上下文约 44KB，返回约 48KB，单次远端读取有时间/体积限制。模型 maxTokens 元数据不是 Codex 后端的硬生成 token 上限；不声称实现了按 token 的消费预算。默认关闭自动压缩和自动重试。

## 验证

真实模型：返回 `PI_CODEX_AUTH_OK`。真实 pi 工具循环：bash 执行 id → write `/workspace/pi-smoke.txt` → read 文件 → 模型返回 UID 1000 与 `PI_SECURE_VM_OK`。四次模型请求各自经过独立批准。另外已通过 pi 的 `gmail_status` 工具实际调用现有 connector，返回已连接。测试没有读取或发送真实邮件。

回归结果：55 项 Python 单元测试、77 项原有 VM 边界/服务检查、10 项 pi 专项检查通过。

新增单元测试覆盖：凭证类型/账户/过期校验、审批前无网络、批准后继续、请求冲突、执行去重、UNKNOWN 不重试、每日限额、禁止托管工具/图片 URL、SSE 完成/中断、错误信息不回显 token，以及同 UID 多 provider 出口规则顺序。

```bash
python3 -m unittest discover -s tests -v
bash scripts/verify.sh
limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run \
  /usr/bin/python3 /opt/secure-vm/check-pi.py
```

后续可以用明确选定的 Gmail 邮件验证 pi 的工具读取与总结；模型请求含邮件内容时，应在独立审批入口审查后批准。当前没有验证真实邮件 prompt injection、交互 TUI、长期会话压缩或进程重启后自动续跑；会话已支持按 session ID 恢复，恢复后等待新指令，不自动重发中断请求。

## 参考

- [Pi 官网与安装](https://pi.dev/)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi 自定义 provider](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)
- [OpenAI 认证文档](https://learn.chatgpt.com/docs/auth)：订阅登录与 API key 是两种认证路径。

订阅接口兼容性依据安装版本的 pi 官方实现。OpenAI 的 Codex 登录文档并不构成对所有第三方客户端接口稳定性的保证；本项目以实际成功调用作为当前兼容性验证。
