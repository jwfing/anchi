# Pi agent: Codex subscription authentication and the secure gateway

Pi runs inside the isolated cell using its `createAgentSession` SDK and a restricted model gateway. Authentication uses the host Codex subscription login, not a Platform API key. Node and Pi versions and architecture-specific Node checksums are pinned in `guest/cell.env`.

For multi-turn use, run `python3 scripts/pi-chat.py`; see [chat and RPC](PI_CHAT.md).

## Installation, authentication and approval

From the repository root:

```bash
# Install or update the deployed runtime.
bash scripts/install-pi.sh
# Unlock after VM restart, then import the host's short-lived Codex access token.
python3 scripts/vault.py unlock
python3 scripts/pi-auth.py
# Send the prompt through stdin; output is JSONL events.
printf '%s' 'Use bash to inspect your UID and briefly describe the runtime.' | bash scripts/pi.sh
```

`pi-auth.py` reads the ChatGPT login cache at `~/.codex/auth.json` and defaults to the model in `~/.codex/config.toml`; override with `--model`. It prints provider, model, expiry and whether a refresh token was imported, never the token. Choose a model available to your subscription; importing configuration does not verify model access.

Model turns use standing authorization by default. Select `bash scripts/policy.sh mode inference ask` for per-turn approval. When `approval_required` appears, use a separate trusted terminal:

```bash
bash scripts/policy.sh pending
bash scripts/policy.sh show APPROVAL_ID
bash scripts/policy.sh approve APPROVAL_ID --digest EXACT_DIGEST
# Or reject it:
bash scripts/policy.sh deny APPROVAL_ID
```

Approval shows the real model input, tool schemas, model and account generation. Each model round, including one after tool results, requires its own approval in `ask` mode. Pi polls the same request every three seconds and resumes without resubmitting the prompt. Neither the cell nor model can approve.

Use `scripts/pi.sh`, not the installed official Pi CLI directly: the latter does not automatically receive the secure provider adapter or credentials. The project provides SDK/JSONL one-shot and RPC entry points plus terminal chat, not the official interactive TUI.

## Request path

```text
Host Codex ChatGPT login cache
  -> access_token/account_id only, via SSH stdin
  -> secure-auth: AES-GCM codex.json.enc

Cell UID 1000: Pi SDK and local/connector tools
  -> connector socket -> connector -> policy -> provider API
  -> custom model provider -> inference Unix socket
       -> validate text/function schemas, fixed model and size
       -> auth releases access token only to inference UID
       -> policy authorizes exact content; consume once
       -> SQLite: WAITING_APPROVAL -> RUNNING -> SUCCEEDED / FAILED / UNKNOWN
       -> fixed POST https://chatgpt.com/backend-api/codex/responses
```

Pi is installed in read-only `/opt/secure-pi`, Node in `/opt/node`, and mutable workspace/session data in `/workspace` and `/workspace/.pi-secure/sessions/`. Extension, skill, prompt-template and AGENTS.md discovery are disabled by default. Only local function tools may be declared; hosted browser/search tools, image URLs and file URLs are forbidden.

[Connector tools](CONNECTORS.md) register at session creation according to connection state. Pi itself executes local tools. Bash can run normal cell programs but has no capabilities, external route, management SSH, policy socket or vault access. Gmail tools provide status/list/read only; `gmail_list` defaults to three messages and the trusted connector cap is ten.

## Credential lifecycle

- Host refresh/id tokens are not copied. Nothing is written to cell `auth.json`; bearer credentials never enter environment variables or command arguments.
- The VM stores access token, account ID, expiry and generation encrypted.
- Expired access fails closed. Refresh/login in host Codex, then rerun `pi-auth.py`; the VM does not compete for refresh-token rotation.
- Reimporting the same account retains generation; switching accounts creates a new generation and invalidates old exact approvals.
- `pi_status` returns configured/provider/model only. Configured means configuration exists, not that upstream authentication has been validated.
- Host cache protection remains the host's responsibility. VM administrators remain trusted.

## Egress, quotas and failures

Inference egress permits public `chatgpt.com` IPs on TCP 443; `api.openai.com` remains for the legacy API-key workflow. Every provider allow rule precedes the UID's final reject. Only the root updater resolves DNS. The gateway connects to fixed numeric targets while verifying TLS hostnames. Shared-IP ACLs cannot distinguish every hosted site; the trusted transport enforces business paths.

The gateway accepts bounded SSE (`response.done`/`response.completed`) or complete JSON. It buffers and validates SSE before handing it to Pi's Responses converter; it does not forward tokens incrementally. Automatic network retries are disabled. Ambiguous timeouts or disconnects become UNKNOWN; reusing the ID cannot execute again, and changing content under an ID is rejected.

Limits: eight model turns per Pi task (a cell-side convenience limit), 50 distinct Codex requests per VM in 24 hours (trusted enforcement, including failed/pending requests), roughly 44 KB context and 48 KB response, plus bounded upstream read time/size. Model `maxTokens` metadata is not a hard Codex generation cap or a token-spending budget. Automatic compaction and retries are disabled.

## Verification

```bash
make check
bash scripts/verify.sh
limactl shell secure-vm -- sudo /usr/local/sbin/secure-cell-run \
  /usr/bin/python3 /opt/secure-vm/check-pi.py
```

`make check` runs offline checks. VM checks require an installed runtime. For protocol and optional synthetic model checks, see [chat verification](PI_CHAT.md#validation). Real-mail prompt-injection evaluation and long-running recovery need separate acceptance; passing infrastructure tests does not establish those guarantees. Automatic compaction and automatic restart continuation are not supported. Session restore waits for new instructions rather than replaying interrupted requests.

References: [Pi](https://pi.dev/), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [custom providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md), [OpenAI authentication](https://learn.chatgpt.com/docs/auth). Compatibility follows the installed Pi implementation and observed calls; Codex login documentation does not guarantee every third-party client interface remains stable.
