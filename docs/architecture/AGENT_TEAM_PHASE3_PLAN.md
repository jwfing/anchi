# Agent team phase 3 plan

**Status: decisions confirmed on 2026-10-07; in progress.** Phases 1 and 2 are implemented ([phase 1](AGENT_TEAM_PHASE1_PLAN.md#status), [phase 2](AGENT_TEAM_PHASE2_PLAN.md#status), [host directories](HOST_DIRECTORIES_PLAN.md)). Phase 3 closes the gaps they left: the security controls that were deferred or simplified, operational rough edges, and the live acceptance still owed.

## Goal and scope

1. **Contain what a compromised or misled agent can do**, now that triggers and delegation let outside content reach agents without the user: high-risk operations always ask, per-agent egress, per-agent policy for connector services.
2. **Make the invariants automatic**: a credential scan of every cell before it is destroyed; isolation checks in CI.
3. **Remove manual upkeep**: Codex token re-import, Linux workspaces, streaming S3 uploads.
4. **Finish acceptance** with real accounts for phases 1 and 2.

| In scope | Not in phase 3 |
|---|---|
| Mandatory approval for high-risk operations | Remote machines (not planned) |
| Per-agent egress allowlists | A GUI client |
| Per-agent policy for Gmail, Drive, Notion and Slack | Telegram or mobile notifications |
| Automatic credential scan before cell destruction | Signed releases and public distribution |
| Codex token re-import without the user | Reviewed-apply workspaces (option B) |
| Linux workspaces (9p) | |
| `aws-chunked` S3 uploads | |
| CLI parity for folded tool calls; isolation checks in CI | |
| Live acceptance of phases 1 and 2 | |

## Acceptance

1. **Privilege borrowing.** A Linear issue polled by a trigger asks `lead` to delegate a force-push and a PR merge to `developer`. Both are held for approval even though `developer` has no `approvals` setting, and the dialog names the chain (`poll → lead → developer`).
2. **Egress.** An agent with `egress: [github.com, registry.npmjs.org]` installs packages and pushes, but `curl https://example.com` from its cell is refused and audited.
3. **Connector policy per agent.** `reader` reads Notion freely while `writer`'s Notion writes wait for approval, at the same time.
4. **Automatic scan.** Every cell destroyed by idle timeout, cancellation or daemon shutdown is scanned first; the result is in the task (`scan: clean (n files)`), and a finding raises a desktop notification.
5. **Codex token.** After the Mac's Codex CLI refreshes its login, the vault holds the new access token within five minutes, with no command from the user.
6. **CI.** The Linux live workflow runs `make verify-anchi` with a synthetic Codex account.
7. **Phases 1 and 2.** `scripts/anchi-acceptance.sh` passes its scenarios; Claude Code completes a multi-turn task with resume; the CJK IME check passes in Terminal.app, iTerm2 and Ghostty.

## Milestones

| # | Milestone | Size |
|---|---|---|
| P1 | Automatic credential scan before destruction | S |
| P2 | Mandatory approval for high-risk operations, with the trigger and delegation chain | M |
| P3 | Per-agent egress allowlists | M |
| P4 | Per-agent policy for connector services | M |
| P5 | Codex token re-import | S |
| P6 | `aws-chunked` uploads | M |
| P7 | Linux workspaces | M |
| P8 | CLI parity and CI isolation checks | S |
| P9 | Live acceptance of phases 1 and 2 | needs your accounts |

### P1 — Automatic scan (S)

- Before the daemon closes a cell (idle timeout, cancel, replacement, shutdown), it runs `anchi-cell scan` and records `scan: clean` or the findings (labels only, never values) as a task notice and in the task row.
- A finding: desktop notification, the task marked with a warning in the task list.
- Daemon shutdown waits for scans up to a bound (30 s), then stops.

### P2 — High-risk operations always ask (M)

- A fixed list of operations held for approval for every agent, whatever its `approvals` setting: force-push and pushes to the default branch, PR merges, repository settings and deletion, branch protection; AWS IAM and resource deletion (`Delete*`, `Terminate*`); Linear deletions; connector-service sends to new recipients when they exist.
- Configurable in `~/.anchi/settings.yaml` (`highRisk: { add: [...], remove: [...] }`), so the user owns the list.
- Tasks carry their origin: `user`, `schedule`, `poll:<item>` or `delegation` with the chain of task ids. The approval dialog shows it, so a write started by an outside issue looks different from one you asked for.
- The proxy learns the cell's origin at registration; the policy service learns it through the connector bridge (P4).

### P3 — Per-agent egress (M)

- Agent field `egress: [host patterns]`; default stays open (today's behavior) so existing agents keep working, and the builder proposes a list.
- The proxy refuses other hosts for that cell with an audited `egress-denied`. Runtime and connector hosts the agent needs are always allowed.
- Image builds keep open egress (they run before the agent exists).
- Limit: an allowed host can still receive data (for example a gist on `github.com`); this narrows exfiltration, it does not end it.

### P4 — Per-agent policy for connector services (M)

- A trusted bridge in the egress service owns per-cell connector sockets, as in the original E2: it forwards to the service and adds `agent:<id>` (and the task origin) as principal; the services accept a principal only from the bridge UID.
- Policy modes, grants, write ledgers and the daily limit become per agent; the TUI shows them per agent.
- Replaces the direct socket binds of phase 2; `make verify-anchi` checks that a cell cannot reach a service socket except through its bridge.
- As built: policy modes and grants are per agent; an agent's `ask` holds its writes only, its reads follow the service's mode. Write ledgers and the daily limit stay per service. The task origin is not sent to the services: the daemon matches a held request to its task by agent and shows the origin from the task.

### P5 — Codex token re-import (S)

- The daemon watches the Mac's `~/.codex/auth.json`; when the access token changed and is newer than the vault's, it imports it (access token and account id only, as `setup codex` does).
- On by default (F4); `codexAutoImport: false` in `settings.yaml` turns it off. Only the access token and account id leave the Mac, as with `setup codex`; the refresh token never does.

### P6 — `aws-chunked` uploads (M)

- Re-sign chained chunk signatures (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`): the proxy re-signs the seed request and recomputes each chunk signature while streaming. Tests against recorded AWS CLI uploads; live check with a dedicated bucket.

### P7 — Linux workspaces (M)

- Spike on 9p in Lima/QEMU: ownership mapping into the user-namespaced cell, performance of `git status` on a large repository. If 9p fails the checks, try virtiofs on Linux hosts.
- Same binds, masks and post-turn audit as macOS.

### P8 — CLI parity and CI (S)

- `anchi run` and `anchi send` fold tool calls into one updating line on a terminal, and print the full list with `--verbose`.
- A synthetic Codex account in CI (a token the proxy never forwards), so `make verify-anchi` runs in the Linux live workflow.

### P9 — Live acceptance (your accounts)

Phase 1 scenarios 1–3 (GitHub private push and PR, AWS logs to issue, Linear comment), phase 2 scenarios 1–5, Claude Code multi-turn with resume, CJK IME in three terminals, Drive sign-in again.

## Decisions

Confirmed on 2026-10-07:

- **F1:** mandatory approval of high-risk operations applies to every origin, including the user's own tasks.
- **F2:** agents without `egress` keep open egress; the builder proposes a list for new agents.
- **F3:** P4 replaces the direct connector socket binds with the bridge now.
- **F4:** Codex token re-import is on by default.
- **F5:** order P1, P2, P5, P8, then P3, P4, P6, P7; P9 when accounts are ready.

## Status

| # | State |
|---|---|
| P1 | Done. Live: scan before close, `scan: clean (1935 files)` |
| P2 | Done. Live: a merge held for an agent without `approvals` |
| P3 | Done. Live: listed host 200, other host refused and audited |
| P4 | Done. Live: `reader` and `writer` read Notion through the bridge; a `writer` write is held as `notion:writer`; `make verify-anchi` 32/32 |
| P5 | Done |
| P6 | Not started |
| P7 | Not started |
| P8 | Done. CI workflow added; not yet run on the Linux runner |
| P9 | Waiting for accounts: Claude token, Drive sign-in, a valid GitHub token |

## Risks

- **Approval fatigue** (P2): too many held operations train the user to press `y`. The default list stays short and specific.
- **Egress lists** (P3) break agents whose tools reach unexpected hosts (telemetry, mirrors). The audit log names the refused host, and the TUI offers to add it.
- **The bridge** (P4) adds a trusted component on every connector call; it must stay small and is covered by the same isolation checks as the proxy.
- **Chunked re-signing** (P6) is security-sensitive streaming code; it gets recorded-traffic tests before any live use.
