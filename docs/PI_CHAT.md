# Pi 多轮聊天与 stdin/stdout 协议

2026-09-19。新增持续运行的 pi 会话与宿主终端客户端。原 `printf ... | bash scripts/pi.sh` 单次调用方式保留。

## 终端聊天

```bash
python3 scripts/pi-chat.py
```

看到 `你>` 后直接输入需求。当前任务完成后可继续追问，pi 会保留本会话上下文。

| 命令 | 用途 |
|---|---|
| `/status` | 查看 session ID、当前任务 ID 和忙闲状态 |
| `/cancel` 或 Ctrl+C | 取消当前模型等待/工具循环，保留会话 |
| `/history` | 查看最近 40 条用户/助手文本，每条最多 8000 字符 |
| `/sessions` | 列出最多 100 个已保存会话的 ID 与修改时间 |
| `/resume UUID` | 恢复指定会话，上下文加载后等你发下一条需求 |
| `/new` | 新建会话，已有历史保留 |
| `/quit` 或 Ctrl+D | 取消当前任务并退出进程 |

也可以启动时恢复：

```bash
python3 scripts/pi-chat.py --resume SESSION_UUID
```

恢复失败会报错退出，不会悄悄切换到新会话。运行中发送另一条需求或切换会话返回 `BUSY`，不会自动排队。需要改变任务时，先 `/cancel`，再发新需求。

聊天终端会显示审批 ID。在独立终端核对并批准：

```bash
bash scripts/policy.sh show APPROVAL_ID
bash scripts/policy.sh approve APPROVAL_ID --digest EXACT_DIGEST
```

每次模型请求仍逐次审批，聊天协议没有 approve 或 token 接口。取消会停止 pi 等待和本地后续执行；已经发出的远端请求可能继续计费或写入网关执行记录，已经完成的工具动作不会回滚。待审批记录不会因本地取消而自动撤销，需要时使用 `policy.sh deny/revoke`，否则按原规则过期。

## 程序通信接口

```bash
bash scripts/pi.sh --rpc
```

保持 stdin 打开，一行一条 JSON。每条命令必须带本连接内唯一的 `id`（1–64 个字母、数字、下划线或连字符）。接口协议版本为 1；这是本项目的受限协议，不是官方 pi CLI 的完整 RPC 协议。

```json
{"id":"first","op":"prompt","text":"记住项目代号 Cedar"}
{"id":"status1","op":"status"}
{"id":"cancel1","op":"cancel"}
{"id":"list1","op":"sessions"}
{"id":"resume1","op":"resume","session_id":"SESSION_UUID"}
{"id":"history1","op":"history"}
{"id":"new1","op":"new"}
{"id":"close1","op":"close"}
```

`prompt` 先返回接受确认，模型/工具异步执行。示例：

```json
{"type":"response","id":"first","op":"prompt","ok":true,"result":{"accepted":true,"session_id":"...","turn_id":"first","busy":true}}
{"type":"approval_required","approval_id":"...","request_id":"...","session_id":"...","turn_id":"first"}
{"type":"assistant","text":"已记住。","stop_reason":"stop","session_id":"...","turn_id":"first"}
{"type":"finished","success":true,"cancelled":false,"session_id":"...","turn_id":"first"}
```

事件中 `turn_id` 关联用户的 prompt 命令；`approval_required.request_id` 是可信模型网关的一次请求 ID，两者用途不同。一次用户需求可能包含多个模型回合/工具调用。`finished` 才表示本次用户需求结束，`prompt` 的接受确认不代表执行成功。

其他事件包含 `ready`、`tool_start`、`tool_end`、`turn_error`、`protocol_error`。解析失败、重复 ID、未知操作或非法字段都会明确拒绝。单行上限 64KiB、prompt 上限 8000 字符、待处理命令最多 32 条；每次用户需求的模型回合计数重新开始，仍最多 8 回合，网关每日限额保持不变。stdin EOF 取消任务并关闭会话，stdout 不再可用时应由调用方结束连接；单次文本调用模式仍在 EOF 后正常执行。

## 持久化和边界

会话依旧在 cell 的 `/workspace/.pi-secure/sessions/`。恢复只接受 UUID，匹配指定目录里的正规 JSONL 文件，拒绝路径穿越、符号链接、错误 header 和超过 16MiB 的文件。会话属于可被 cell 修改的非可信数据，恢复上下文不等于恢复任何批准或权限。

恢复不自动重发中断的模型请求，也不自动执行历史工具动作。它加载会话上下文并等待新指令；新指令产生新的模型请求，仍经完整内容审批。模型保持可信网关当前配置，不允许聊天客户端指定 endpoint、token 或后台权限。

每个进程仅有一个活跃会话，VM 仍只允许一个 cell 同时运行。退出聊天后才能启动另一个 cell 命令。暂不支持后台任务队列、Web UI、自动压缩或多 cell 并发。上下文增长仍可能触发网关约 44KB 上限，此时可用 `/new` 开始新会话。

## 测试

```bash
node --test pi/tests/*.test.mjs
python3 -m unittest discover -s tests -q
python3 scripts/check-pi-rpc.py
# 实际模型测试，需要为脚本输出的合成请求逐次批准：
python3 scripts/check-pi-rpc.py --live
```

离线协议测试覆盖忙闲/取消、重复命令、历史恢复、EOF 清理和超长行处理。真实 VM 测试验证审批等待中状态可查与取消、跨 cell 进程恢复、禁止任意路径恢复；`--live` 额外验证连续追问与进程重启后模型仍能回忆合成标记，不涉及真实邮件。

本轮实测通过：5 项 Node 协议/会话测试、55 项 Python 回归测试；真实 pi 完成两轮记忆对话，关闭 cell 进程后恢复同一 session，第三轮仍正确返回 `PI_RPC_MEMORY_213db825`。等待审批时的取消在 5 秒内完成，恢复动作本身未发起模型调用。
