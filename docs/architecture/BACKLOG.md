# Backlog

Open requests and known gaps of the secured agent team that are not planned into a phase yet, and what was delivered from this list. Checked against the code on 2026-10-08.

## Open

| # | Item | State |
|---|---|---|
| R1 | Preview the files an agent changed, through a plugin | Not started; design questions below |
| R3 | A clean start for a new task | Partly: **^X n** starts a new session; all of an agent's tasks share its work directory |
| G1 | git pushes over 8 MiB | Fail: the body streams before the push can be decided, and streamed requests other than S3 get no credential |
| G2 | Linux workspaces (phase 3 P7) | After Linux hosts are confirmed on a Linux machine |
| G3 | Live acceptance with real accounts (phase 3 P9) | Needs a Claude token, Drive sign-in again, and an AWS bucket for `aws-chunked` uploads |
| G4 | Allow a refused egress host from the TUI | The audit log names it (`egress-denied`); adding it to `egress` is a manual edit |
| R8 | Audit log of each task's external access, for the user to see | Recorded in the VM; no way to view it from Anchi |
| R9 | Token use of Codex and Claude Code, totals, and how much of the subscription quota is used | Per-task input and output tokens only |

## R1 — File preview through a plugin

**Request.** When an agent develops, the transcript says which files it touched. Being able to list and preview those files, which live in the VM, would help a lot. Build it as a plugin, after the model of [herdr plugins](https://herdr.dev/docs/plugins/) and [herdr-file-viewer](https://github.com/smarzban/herdr-file-viewer); reusing herdr or other third-party plugins would be best.

**Today.**

- No file-change event: a Codex `file_change` becomes a generic `tool.call` named `apply_patch` whose result is one `<kind> <path>` line per file (`cell-runner/src/codex.ts`); Claude `Edit`/`Write` are generic tool calls with their JSON input (`cell-runner/src/claude.ts`). The TUI summarizes only `command`, `path`, `query` and `url`, so both show as truncated JSON (`tui/src/tui/lines.ts`).
- No RPC, CLI or TUI view lists or shows files of an agent's home or workspace. The guest has `anchi-cell exec <task> -- <cmd>` (nsenter into a live cell as the agent user); the daemon does not use it. `limactl shell` reaches the VM, not a cell.
- No plugin mechanism in the daemon or the TUI.

**herdr's model, for reference.** A plugin is a directory with `herdr-plugin.toml` declaring `[[actions]]`, `[[panes]]`, `[[events]]`, `[[build]]` and `[[link_handlers]]`. Panes are terminal processes that herdr places as a split, tab, popup or overlay; plugins get `HERDR_*` environment variables (socket, pane, context JSON) and call back through the herdr CLI or socket. No sandbox: a plugin is trusted like an editor extension. herdr-file-viewer is a Rust/ratatui, read-only, git-aware viewer (MIT) that browses a local directory and renders diffs, Markdown and code.

**Open questions.**

1. **Where the viewer runs.** The files are in the VM (agent home `/var/lib/anchi/agents/<id>/home`, live cells) or under `~/AnchiWorkspaces`. Options: run a viewer inside the VM as an unprivileged user over `limactl shell` and hand it the terminal (like Ctrl+G for the editor); copy a snapshot to the host; or an Anchi-native view fed by an RPC (`files.list`, `files.read`) with bounded, sanitized output.
2. **Reuse herdr-file-viewer?** The Anchi TUI is an Ink app, not a terminal multiplexer, so herdr panes cannot be embedded. It could run full-screen in place of the TUI, inside the VM against the agent's directory. herdr-specific actions and its CLI callbacks would not work.
3. **Trust.** Plugins are trusted code. The content they render is untrusted (agent-written): a viewer must not run anything from it, and anything on the host must not follow links out of the agent's directory. Never run a plugin with access to the vault or credentials.
4. **Plugin manifest for Anchi.** Which entry points (a key action on a task, a full-screen view, a transcript link handler), what context (agent, task, paths from the turn), and how it is installed (`anchi plugin install owner/repo`, pinned by commit like skills).
5. **A file-change event** in the runner protocol (path, kind, diff stats), so the transcript lists changed files and a viewer can open them directly.
6. **Keys:** plugin actions become named actions in the key map (`plugin:<id>.<action>`), so they can be bound and appear in the command palette.

## R3 — A clean start for a new task

**Request.** An explicit "new chat": a new task that starts from scratch rather than continuing the shown task.

**Today.** **^X n** (or `/new`) makes the next message a new task with a new Codex or Claude Code session; the footer, the help and the command palette show it. Not separate: the agent's home, including `/home/agent/work` and the runtimes' session files, is shared by all its tasks, so a new task sees the files earlier tasks left.

**Open question.** Per-task work directories (or an option to start in an empty one), and what happens to a repository an earlier task is still working in.

## G1 — git pushes over 8 MiB

**Today.** mitmproxy streams bodies over 8 MiB and sends their headers before the body is read. The proxy decides streamed requests when their headers arrive and injects only S3 calls there (their operation and risk come from method and path). A git push needs its ref updates, which are at the start of the body, to decide whether it is high-risk, so it leaves without a credential and fails upstream; the audit log records `pass:streamed`.

**Options.** Read the push's ref commands from the first bytes of the stream before forwarding (the pkt-lines precede the pack), then inject; or raise the streaming threshold for `git-receive-pack` at the cost of buffering large packs in memory.

## R8 — Audit log of external access

**Request.** Agents reach outside systems only through the proxy, which swaps placeholders for credentials. Record that and show it to the user: for a task, which external systems its agents reached and how, so the user can see that the "secured" claims hold.

**Today.**

- The proxy appends JSON lines to `/var/log/anchi-egress/audit.jsonl` in the VM: per request the task, agent, method, host, path (no query string), rule, operation and decision (`inject`, `pass`, `deny`, `held-*`, `egress-denied`, `blocked-destination`, `pass:streamed`, `upstream-error`), what the cell sent as credential (`placeholder`, `none` or `other`), high-risk id and approval outcome; per cell its registration (connectors, `ask`, egress list, services) and end; per bridge call the service and operation; connector verification and polls. Header values and query strings are never written.
- The policy service keeps its own audit of connector-service grants and decisions (`policy_admin.py audit`).
- Credential scans before a cell closes are noted in the task.
- There is no RPC, CLI command or TUI view for any of it; only root in the VM can read the file. It is never rotated (1.6 MB and 6,668 lines after two days), and it mixes in the `chk-*` cells of `make verify-anchi`.

**Possible shape.**

- A daemon RPC, `audit.task {taskId}`, reading the task's rows through a fixed guest command (`anchi-cell audit TASK`), bounded and filtered by task id in the VM.
- **TUI:** an **Access** tab in the task view: hosts reached, with counts and decisions; which connector injected credentials; writes held and their outcome; refused hosts; bridge calls; the scan result.
- **A summary line that backs the claims:** "42 requests, 17 with credentials injected; the cell sent only placeholders; 2 hosts refused; scan clean".
- **CLI:** `anchi audit <task> [--json]`.
- **Retention:** rotate the file and delete rows with the task (`anchi rm`) or after `retentionDays`; keep check cells out of it, or mark them.

**Open questions.**

1. Trust in the view: the rows are written by the trusted proxy, but hosts and paths come from agent requests; render them sanitized like any agent text.
2. Per-request rows or an aggregate only (hosts and counts), and how long to keep each.
3. Whether to include traffic that is not credentialed (package downloads, web reads), which is most of it.
4. A global view across tasks (by agent, by connector) as well as the per-task one.

## R9 — Token use and subscription quota

**Request.** Track the tokens Claude Code and Codex use, with global totals, so the user knows how much of the subscription's quota is used.

**Today.**

- The runner reports `usage` events (input and output tokens) from the runtimes: Codex at the end of each turn, Claude Code with each result.
- The daemon adds them to the task (`input_tokens`, `output_tokens`), and the task view shows "12.3k in / 4.5k out".
- Not recorded: cached input tokens, reasoning tokens, Claude's reported cost, the model used, or time. There are no totals by agent, runtime, model or day.
- Nothing about subscription quotas.

**Possible shape.**

- **Record per turn:** runtime, model, input, cached input and output tokens, and cost where the runtime reports it. Turns are the unit the runtimes report.
- **Totals:** a **Usage** screen under Configure, and `anchi usage [--since 7d] [--by agent|runtime|model]`, aggregated from the task store.
- **Quota:** the egress proxy already sees every response from `chatgpt.com` and `api.anthropic.com`. Subscription plans return rate-limit and usage information there: Codex's usage-percent windows, and Anthropic's unified rate-limit headers for subscription tokens. The proxy, on the trusted side, could record the latest values per runtime, and the daemon could show "Codex: 5-hour window 38% used, resets 14:20". This covers every cell without trusting the runtime's own reports.

**Open questions.**

1. Which response headers or fields each plan returns, and their stability: to verify against live traffic before relying on them.
2. Whether to warn (notification, footer) when a window passes a threshold, and whether to pause triggers when a quota is nearly used.
3. Cost for subscriptions is notional; show tokens and quota, and cost only for API-key use.

## Delivered

| # | Requirement | Where |
|---|---|---|
| R2 | Delete an agent with its tasks and VM files; workspaces untouched | #33; [Delete an agent](../AGENT_TEAM.md#delete-an-agent) |
| R4 | Skills from a URL or a local directory, given to agents in a settings panel, updated to a reviewed commit | #32; [Agent settings](../AGENT_TEAM.md#agent-settings) |
| R5 | The builder knows what exists; proposals are checked and their settings adjustable | #32; [Create agents](../AGENT_TEAM.md#create-agents) |
| R6 | Key bindings: leader key, plain keys in views, command palette, line editing, `keybindings.json` | #31; [Key bindings](../KEYBINDINGS.md) |
| R7 | Run a failed or cancelled task again, continuing its session or from scratch | #34; [Run tasks](../AGENT_TEAM.md#run-tasks) |
