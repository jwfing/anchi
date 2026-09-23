# Pi chat and stdin/stdout protocol

Use terminal chat for interactive sessions or RPC v1 for desktop integration. The one-shot `printf ... | bash scripts/pi.sh` interface is also available.

## Terminal chat

```bash
python3 scripts/pi-chat.py
python3 scripts/pi-chat.py --resume SESSION_UUID
```

Enter a request at the user prompt. After completion, follow-up requests retain session context.

| Command | Purpose |
|---|---|
| `/status` | Session ID, turn ID and busy state |
| `/cancel` or Ctrl+C | Cancel current model wait/tool loop while retaining the session |
| `/history` | Up to 40 recent user/assistant texts, at most 8,000 characters each |
| `/sessions` | Up to 100 saved session IDs and modification times |
| `/resume UUID` | Load a session and wait for the next request |
| `/new` | Start a new session while preserving old history |
| `/quit` or Ctrl+D | Cancel the task and exit |

Failed restoration exits with an error rather than silently creating a new session. A new prompt or session switch while busy returns `BUSY`, without queuing. Cancel before changing the task.

Model requests are automatically authorized by default. When `inference` is set to `ask`, inspect and approve the displayed request in a separate terminal:

```bash
bash scripts/policy.sh show APPROVAL_ID
bash scripts/policy.sh approve APPROVAL_ID --digest EXACT_DIGEST
```

Chat has no approval or token interface. Cancellation stops local waiting and subsequent execution, but remote requests may continue billing or updating the gateway ledger. Completed tool actions are not rolled back. Pending approvals require explicit deny/revoke or expire normally.

## RPC v1

```bash
bash scripts/pi.sh --rpc
```

Keep stdin open and send one JSON object per line. Each command needs a connection-unique `id` of 1–64 letters, digits, underscores or hyphens. This is the project's restricted protocol, not the complete official Pi CLI RPC protocol.

```json
{"id":"first","op":"prompt","text":"Remember the project name Cedar"}
{"id":"status1","op":"status"}
{"id":"cancel1","op":"cancel"}
{"id":"list1","op":"sessions"}
{"id":"resume1","op":"resume","session_id":"SESSION_UUID"}
{"id":"history1","op":"history"}
{"id":"new1","op":"new"}
{"id":"close1","op":"close"}
```

`prompt` acknowledges acceptance before asynchronous model/tool execution:

```json
{"type":"response","id":"first","op":"prompt","ok":true,"result":{"accepted":true,"session_id":"...","turn_id":"first","busy":true}}
{"type":"approval_required","approval_id":"...","request_id":"...","session_id":"...","turn_id":"first"}
{"type":"assistant","text":"Remembered.","stop_reason":"stop","session_id":"...","turn_id":"first"}
{"type":"finished","success":true,"cancelled":false,"session_id":"...","turn_id":"first"}
```

`turn_id` identifies the user's prompt. `approval_required.request_id` identifies one trusted gateway request. One prompt can produce several model turns and tools. Only `finished` indicates task completion; acceptance is not success.

Other events: `ready`, `tool_start`, `tool_end`, `turn_error`, `protocol_error`. Invalid JSON, duplicate IDs, unknown operations and illegal fields are rejected. Limits are 64 KiB per line, 8,000 prompt characters and 32 pending commands. Each prompt resets the cell's eight-model-turn limit; the trusted daily gateway quota still applies. stdin EOF cancels and closes RPC, while one-shot text mode still executes after EOF. Callers should close connections whose stdout is no longer usable.

## Persistence and boundaries

Sessions live in `/workspace/.pi-secure/sessions/` inside the cell. Restore accepts UUIDs only and requires a regular JSONL file in that directory with a valid header and size no greater than 16 MiB. Traversal and symlinks are rejected. These are untrusted, cell-writable files; restoring context restores no approvals or permissions.

Restore does not resend interrupted requests or replay tools. It waits for a new instruction, whose model requests follow current authorization policy. Model configuration comes from the trusted gateway; clients cannot set endpoints, tokens or background privileges.

Each process has one active session; the VM permits one cell at a time. There is no background queue, automatic compaction, Web UI or concurrent multi-cell operation. Growing context can hit the roughly 44 KB UTF-8 gateway limit; use `/new` when necessary.

## Validation

```bash
node --test pi/tests/*.test.mjs
python3 -m unittest discover -s tests -q
python3 scripts/check-pi-rpc.py
# Real model check: temporarily selects ask mode; approve only the displayed synthetic requests.
python3 scripts/check-pi-rpc.py --live
```

Offline coverage includes busy/cancel handling, duplicate IDs, history/restore, EOF cleanup and oversized lines. VM checks exercise status/cancel while awaiting approval, cross-process restore and arbitrary-path rejection. `--live` additionally verifies follow-up memory and restart recovery using synthetic markers, not mail.
