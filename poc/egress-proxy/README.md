# PoC: credential-injecting egress proxy

Throwaway spike for [the agent team design](../../docs/architecture/AGENT_TEAM_DESIGN.md#credential-boundary-egress-proxy). It runs on the macOS host first. It answers one question: can real clients work with placeholder credentials while the proxy injects or re-signs the real ones?

| File | Role |
|---|---|
| `anchi_inject.py` | mitmproxy addon: rules, injection, AWS SigV4 re-signing, deny lists, secret-free JSONL log |
| `test_inject.py` | Offline checks with fake credentials (`.venv/bin/python -m pytest -q test_inject.py`) |
| `start-proxy.sh` | Starts the proxy. Real credentials come only from `ANCHI_POC_*` variables you export |
| `run-client.sh` | Runs `claude`, `codex`, `gh`, `git` or `aws` with placeholders and an isolated `HOME`, then summarizes what the proxy saw |

The log (`out/flows.jsonl`) records method, host, path, the matched rule, the decision, and whether the client sent a placeholder, another credential or none. It never records header values.

## Setup (once)

```bash
cd poc/egress-proxy
python3 -m venv .venv && .venv/bin/pip install mitmproxy botocore pytest
```

## Terminal 1: proxy (you run this; it holds the real credentials)

Export only the credentials you want to test. Missing ones make matching requests fail closed with 502.

```bash
cd poc/egress-proxy
export ANCHI_POC_CLAUDE_TOKEN=...          # output of: claude setup-token
export ANCHI_POC_CODEX_ACCESS_TOKEN=$(jq -r .tokens.access_token ~/.codex/auth.json)
export ANCHI_POC_CODEX_ACCOUNT_ID=$(jq -r .tokens.account_id ~/.codex/auth.json)
export ANCHI_POC_GITHUB_TOKEN=$(gh auth token)
export ANCHI_POC_AWS_ACCESS_KEY_ID=$(aws configure get aws_access_key_id)
export ANCHI_POC_AWS_SECRET_ACCESS_KEY=$(aws configure get aws_secret_access_key)
./start-proxy.sh
```

## Terminal 2: clients (placeholders only)

```bash
cd poc/egress-proxy
./run-client.sh claude
./run-client.sh codex
./run-client.sh gh
ANCHI_POC_REPO=owner/private-repo ./run-client.sh git
./run-client.sh aws
```

In Claude Code you can also run these as `! poc/egress-proxy/run-client.sh claude` so the output lands in the conversation.

## What each run should show

| Target | Pass criteria | Open question it answers |
|---|---|---|
| `claude` | Prints `hi`; every Anthropic request shows `client=placeholder` and `injected` | Local token-format checks; full list of Anthropic hosts contacted |
| `codex` | Prints `hi`; `chatgpt.com` requests are injected; no `auth.openai.com` entry | Whether a placeholder `auth.json` triggers a local refresh (that would show as `denied` on `auth.openai.com`) |
| `gh` | `gh api user` prints your login; `POST /user/keys` returns the anchi 403 | Whether `gh` (Go) trusts `SSL_CERT_FILE` on macOS. If not, only the curl fallback passes; Linux cells are unaffected |
| `git` | SSH-style URL is rewritten to HTTPS and the private repo clones | Basic-auth injection for git smart HTTP |
| `aws` | `get-caller-identity` succeeds; `iam create-access-key` and `sts get-session-token` return the anchi 403 | SigV4 re-signing and minting denial. The deny checks use a nonexistent user and an invalid duration, so even a failed denial creates no credential |

Any `client=other` entry on a rule host means the client used a real credential it found elsewhere, for example the macOS keychain. That would make the result a false positive.

## Caveats

- The mitmproxy CA and its private key live in `out/mitm/`. `out/` is ignored by git. Delete it when done.
- On the host, clients that ignore the proxy variables bypass the proxy entirely. In the cell, the same clients will fail closed because the cell has no other route.
