# 只读邮件工作流、推理网关与任务恢复

本文件描述旧受限工作流。真实 pi agent 现已部署，使用 Codex 订阅认证，见 [Pi 接入](PI_AGENT.md)；无需为 pi 配置这里的 Platform API key。

状态：工作流和独立推理网关已部署，真实 Gmail 采集与离线演示通过。云模型未配置/未调用；等待用户选择模型并提供相应配置。发送、删除、修改邮件继续不支持。

## 能做什么

这是一个受限 harness：按用户给定查询列出邮件，读取最多 3 封，通过受控推理接口总结，保存报告。它暂不让模型自行规划任意工具调用，也没有 shell、浏览器、自动定时任务或跨任务记忆。

```bash
# 查看是否启用了真实模型
bash scripts/agent.sh status

# 只读取 Gmail 并保存本地邮件摘录，不调用模型
bash scripts/agent.sh collect --query 'in:inbox newer_than:7d' --limit 3

# 固定合成示例，不读取 Gmail，也不调用任何模型
bash scripts/agent.sh demo

# 启用模型后，读取邮件并总结
bash scripts/agent.sh summarize --limit 3 --task '总结邮件并整理待办与期限'

# 最近 20 个推理任务的状态；不返回邮件原文
bash scripts/agent.sh history

# 通过任务 ID 取回已保存的结果，不再次调用模型
bash scripts/agent.sh result REQUEST_ID
```

报告保存在 cell 内 `/workspace/reports/`。采集报告保存截断后的邮件数据，摘要报告保存结果，权限为 0600。默认每封正文最多传入 1500 字符、snippet 200 字符，各邮件头 200 字符；它们是摘录，不能当作完整邮件。现有连接器的链接/数字过滤也会影响信息完整性。

输出中的 `demo: true`、`provider: fixture` 表示固定测试结果，明确不是模型生成。

## 数据和权限路径

```text
cell 内的 agent.py
  ├─ Gmail socket → secure-gmail → secure-auth → Google Gmail API（只读）
  └─ Inference socket → secure-inference → 已明确配置的模型
                            └─ 受保护的 SQLite 执行记录
```

推理 socket 只接受 guest host 视角 UID 525288。Cell 无法读取模型配置、API key、SQLite 文件，也不能在请求中改 provider、model、endpoint、headers 或 tools。配置由 guest root 管理，服务只读。

Gmail 与模型凭证均由 secure-auth 加密保存，只向对应服务 UID 返回；`/etc/secure-vm/model.json` 仅保存非秘密配置。每次真实模型请求都经 policy 签发一次性授权：`inference` 处于默认的 `auto` 时自动签发；处于 `ask` 时返回 `APPROVAL_REQUIRED:<id>`，先按 [安全基础说明](SECURITY_FOUNDATION.md) 审批，再使用相同 request ID 重试。VM 管理员仍属可信主体。

推理网关不具备 Gmail credential socket 或邮箱读取能力。邮件由 cell 经验证过的文本 schema 提交。允许云推理后，gateway 不能证明这些文本一定来自那几封邮件；这是固定模型服务作为可信数据接收方的设计边界，不是通用数据防泄露系统。

## 启用真实模型

默认关闭；未配置时 summarize 返回 `MODEL_NOT_CONFIGURED`，且在读取邮箱前停止。目前实现了可选的 OpenAI Responses API 适配器；没有内置默认模型，也没有部署本地模型。若选本地或其他 provider，需要添加相应适配器后再启用。

确定使用 OpenAI，并允许选中的邮件文本用于云端推理后，在可信 macOS 管理端执行：

```bash
python3 scripts/model-config.py \
  --model YOUR_MODEL_ID \
  --key-file /absolute/path/to/api-key.txt \
  --allow-cloud-mail
```

key 文件只包含 API key，不是 JSON 或 `.env`。密钥通过 SSH stdin 导入，不写入 shell 参数、cell 或普通日志；也不要粘贴到聊天里。该命令配置完成并不证明账户有权调用选定模型，需另行完成一次真实请求。

网关固定使用 `https://api.openai.com/v1/responses`，不跟随重定向，不使用环境代理；DNS 结果必须为公网地址，TLS 使用正确主机名验证。请求固定 `store: false`、`tools: []`、`stream: false`、`max_output_tokens: 2048`；不接收调用方提供的模型或其他 API 参数。`store: false` 不是零数据保留承诺。[OpenAI Responses API 文档](https://developers.openai.com/api/reference/python/resources/responses/methods/create)

邮件内容始终作为不可信数据输入，系统指令在网关固定。模型只返回文本，任何函数调用或其他动作输出会被拒绝。模型总结仍可能受提示注入影响或产生错误，系统不会执行其输出。

停止后续云推理：

```bash
python3 scripts/model-config.py --disable
```

这会删除本地模型配置；不能取消已经在途的请求，也不删除历史摘要。需要撤销 API key 时在 provider 侧操作。

## 限额与恢复

- 每次 1–3 封邮件；规范化请求最多 48 KB（按 ASCII JSON 编码计算）。
- task 最长 1000 字符；模型输出最多 2048 tokens，返回文本额外有 8000 字符上限。
- 每 provider 滚动 24 小时最多 50 个新推理任务，失败请求也占额度。离线示例单独计数。
- 这是请求次数/输出大小限制，不是精确美元预算或总输入 token 预算。
- request ID 与输入、provider、model 的哈希绑定；相同 ID 不同输入拒绝，相同成功请求返回缓存结果。
- 失败或结果不明的相同请求不自动重试。重新运行 summarize 会生成新任务，应先通过 history/result 确认旧任务状态。

SQLite 位于 `/var/lib/secure-inference/runs.sqlite3`，在 cell 外由推理服务独占。它保存 provider、model、时间、输入哈希、状态和成功摘要；不保存输入邮件原文、任务原文或密钥。摘要本身也可能包含个人信息。

状态为 `RUNNING / SUCCEEDED / FAILED / UNKNOWN`。服务启动时把中断的 RUNNING 改为 UNKNOWN，不自动重新发送；已成功任务可通过 result 取回。网关不能与云 provider 组成原子事务，响应丢失时仍可能无法确定远端是否已计费。

当前执行记录覆盖推理，不是所有 Gmail 调用的完整审计。报告和摘要尚无自动保留期限、加密备份或清理策略。

## 2026-09-18 验收

- 30 个单元测试通过，包含重复请求、变更输入、未知结果、持久限额、恢复、云授权开关、越权字段和异常模型动作。
- 真实 VM 中 24 项基础隔离、10 项 Gmail 边界、11 项推理边界检查全部通过。
- harness 使用现有 Gmail 授权采集到 3 封近期邮件；`inference_performed: false`。
- 离线任务完成报告写入，并在服务重启后通过 ID 取回原结果。
- 未配置模型时 summarize 返回 `MODEL_NOT_CONFIGURED`。
- 尚未验证真实模型请求、模型总结质量或真实模型计费；没有发送邮件。

可以复测：

```bash
python3 -W error::ResourceWarning -m unittest discover -s tests -v
bash scripts/verify.sh
```
