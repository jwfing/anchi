# M5 / M6 / M7 实现与验收

> 本文中的测试数量与验证结果为当日记录；当前以 `make check` 的输出为准。

2026-09-18。本轮补齐当前单用户、只读 Gmail MVP 的安全基础。随后 M8 已部署真实 pi agent，见 [Pi 接入](PI_AGENT.md)。发送功能仍未实现，也未测试发信。

## M5：凭证库

`secure-auth` 独立 UID 持有 OAuth client、access/refresh token、PKCE 临时状态和可选模型 key。文件在 `/var/lib/secure-auth/*.json.enc`，使用 AES-256-GCM、随机 12 字节 nonce，逻辑文件名作为 AAD，防止不同凭证文件互换。目录 0700，文件 0600，原子替换并 fsync。

主密钥是 macOS 管理端 `~/.config/secure-vm/vault.key` 的 32 字节文件，权限 0600，不在项目或 VM 磁盘里。解锁时经 Lima SSH stdin 传入 guest root 管理入口，只保存到 tmpfs `/run/secure-vault/master.key`。VM 禁用 swap，服务与密钥管理工具禁止 core dump；重启后必须重新解锁。

```bash
python3 scripts/vault.py init    # 首次生成；已有密钥时仅解锁
python3 scripts/vault.py status
python3 scripts/vault.py lock
python3 scripts/vault.py unlock  # 每次 VM 重启后运行
```

已有明文凭证迁移时先加密、解密核对，再删除旧文件；本机 client/token 已迁移，真实 Gmail 仍可列出 3 封邮件。没有明文回退。错误密钥不会替换已解锁的正确密钥。请单独保护主密钥备份；丢失后无法解密，需重新授权。

Google access token 仅返回给 `secure-gmail`；模型 key 仅返回给 `secure-inference`。内核 `SO_PEERCRED` 提供调用者身份，RPC 自报角色没有效力。刷新仍由 auth 服务串行执行。重新授权产生新的账户 generation，旧账户的精确批准不可用于新账户。

断开先删除本地可用 token，再尝试 Google `/revoke`。远端失败时保留加密的撤销重试材料，返回 `remote_revoked:false, revocation_pending:true`；再次执行 disconnect 重试。不会将这份材料作为可用账户 token 返回。已在途的调用不能靠锁库或断开撤回。本轮远端撤销采用模拟测试，未撤销用户真实授权。

保护范围是凭证文件静态加密，不是整盘加密。邮件工作区、审批暂存正文和摘要仍未加密；迁移前的旧磁盘块/旧备份不保证被安全擦除。macOS 管理员、运行中的 guest root、含内存的快照仍是可信边界，不能声称对它们保密。目前没有 Keychain/TPM 托管或自动密钥轮换。

## M6：独立策略与审批

`secure-policy` 是独立 UID 和 systemd 服务，无 IP 网络，cell 看不到它的 socket。仅 Gmail 和 inference 网关能调用 authorize/consume；它们无法通过 RPC 批准。管理命令经宿主的 Lima SSH 身份进入 guest root，再降权操作 policy 数据库。

```text
cell 请求
 → gateway 验证操作与参数
 → auth 取得对应凭证与 account generation
 → policy 对规范化 operation/account/params 做决定
   → 主体处于 auto（默认）：签发短期一次性授权
   → 主体处于 ask：返回 APPROVAL_REQUIRED:<id>，暂停
 → gateway 原子消费一次性授权
 → 固定 provider HTTPS 请求
```

授权绑定：调用服务身份、完整规范化请求的 SHA-256、账户 generation、策略 epoch、当前 Linux boot ID、有效期。一次性随机 ticket 的哈希入库，消费使用 SQLite 事务。待审批请求有效 10 分钟，签发后的 ticket 有效 60 秒。修改内容、跨账户、重放、过期、撤销、策略变更或正常重启均导致拒绝。

```bash
bash scripts/policy.sh pending
bash scripts/policy.sh show APPROVAL_ID
bash scripts/policy.sh approve APPROVAL_ID --digest EXACT_DIGEST
bash scripts/policy.sh deny APPROVAL_ID
bash scripts/policy.sh revoke APPROVAL_ID
```

`show` 显示真实 operation/account/params，包括即将发送给模型的完整输入；应审查内容后使用对应 digest 批准。终端 JSON 转义控制字符，邮件内容只作为数据。批准后重试原始请求；推理记录使用 `WAITING_APPROVAL`，支持相同 request ID 继续；外部调用结果不确定仍为 `UNKNOWN`，不会自动重试。

每个主体（`gmail`、`drive`、`notion`、`slack`、`inference`）有一个模式，缺省为 `auto`：策略按白名单自动签发一次性授权，读写与模型调用都不需要人工批准；`ask` 则每个操作都进入上面的审批流程。可信管理端可以切换：

```bash
bash scripts/policy.sh rules                  # 查看全部主体的模式
bash scripts/policy.sh mode gmail ask         # Gmail 改为逐次审批
bash scripts/policy.sh mode inference auto    # 模型调用恢复持续授权
```

更改模式会递增 epoch 并撤销所有未消费 grant。`ask` 不是永久禁止，而是把决定交回给人。每条请求在两种模式下都受固定操作/参数白名单、修订绑定与每日次数上限约束。`read <connector> allow|deny` 与 `gmail-read` 仍作为别名保留一个版本。没有 gmail.send 授权路径。

数据库 `/var/lib/secure-policy/policy.sqlite3` 存储 grant 和审计元数据；每次 authorize 清理 7 天前请求正文和 30 天前审计。无流量时不会定时清理。当前没有细分任务/会话权限、多租户、Web 审批或发送对象/MIME 冻结。boot ID 防止正常冷重启恢复旧 grant，不解决同一启动内数据库回滚或完整内存快照回滚；这些仍属后续恢复设计。

## M7：内核出口控制

Cell 继续使用无外部路由的独立 network namespace。Guest host 新增 nftables `inet secure_vm` output 链，按 socket UID 执行规则，IPv4/IPv6 均覆盖：

| UID 对应服务 | 唯一允许的外部目的地 |
|---|---|
| secure-auth | oauth2.googleapis.com 解析的公开 IP，TCP 443 |
| secure-gmail | gmail.googleapis.com 解析的公开 IP，TCP 443 |
| secure-inference | api.openai.com、chatgpt.com 解析的公开 IP，TCP 443 |
| secure-policy、映射 agent UID 525288 | 不允许任何 IP 出口 |

每个受控 UID 在允许规则之后都有 reject，覆盖其他 TCP、UDP、DNS、私网/宿主和 IPv6 目的地。Guest 管理用户/root 仍可联网，不能交给 agent。

仅 root 更新服务可以解析上述固定域名。解析结果必须全是公开地址；原子更新 nft IP set，并写入 `/run/secure-egress/targets.json`。网关直接连接文件中的数值 IP，不执行 DNS，仍使用原域名进行 TLS SNI 和证书校验。服务依赖出口规则初始化成功才启动。

每 2 分钟刷新；targets 文件 4 分钟过期，内核元素 5 分钟过期。刷新故障不会开放直连：短期继续使用旧有效集合，到期拒绝。HTTPS 由固定业务代码构造路径/方法，不跟随重定向，不使用环境代理，无任意 CONNECT 通道。

内核只检查 IP/端口，不能区分同 IP 承载的不同域名或 API。路径、HTTP 方法和请求内容仍由可信网关检查；若该网关本身被攻陷，可能滥用允许 IP 上的其他服务。没有独立 L7 出口代理，也没有 taint tracking。这套边界适用于当前固定连接器，不能直接扩展为任意浏览器的安全保证。

## 验证与后续

复测命令：

```bash
python3 -m unittest discover -s tests -v
bash scripts/verify.sh
```

M5–M7 初始验收包括：43 项单元测试；真实 cell 的 24 项隔离、12 项 Gmail 和 11 项推理边界检查；guest 中 28 项凭证/身份/审批/网络集成检查。出口负向测试直接以各服务 UID 创建裸 socket，正向测试只做 provider TLS 握手，不发送凭证；云模型未被调用。IPv6 在无可用路由时也会失败，因此该项还依赖对已安装 IPv6 nft 规则的检查。

额外完成真实 Gmail 迁移后读取、锁库拒绝、VM 完整重启自动锁库、重启后的出口规则恢复及解锁恢复。没有发送邮件，没有真实远端 revoke 测试。

后续 M8 已完成真实 pi 部署、Codex 订阅推理、审批后继续及本地工具循环，见 [Pi 接入记录](PI_AGENT.md)。真实邮件与恶意邮件行为仍待测试。`guest/agent.py` 继续作为旧受限工作流入口，真实 agent 入口为 `scripts/pi.sh`。
