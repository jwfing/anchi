# Backlog

Open requests and known gaps of the secured agent team that are not planned into a phase yet, and what was delivered from this list. Checked against the code on 2026-10-08.

## Open

| # | Item | State |
|---|---|---|
| R1 | Preview the files an agent changed, through a plugin | Not started; design questions below |
| R3 | A clean start for a new task | Partly: **^X n** starts a new session; all of an agent's tasks share its work directory |
| G2 | Linux workspaces (phase 3 P7) | After Linux hosts are confirmed on a Linux machine |
| G3 | Live acceptance with real accounts (phase 3 P9) | Needs a Claude token, Drive sign-in again, and an AWS bucket for `aws-chunked` uploads |
| G5 | Cell count disagrees between the daemon and the VM | The daemon counts its own live cells; the VM counts cell directories, including cells still closing. A task started as an idle cell closes can fail with `TOO_MANY_CELLS` |
| G6 | Claude subscription limits | The proxy keeps `anthropic-ratelimit-*` headers, but which ones a Claude subscription returns is not verified against live traffic (no Claude token yet; with G3) |
| G8 | Large high-risk pushes | A streamed push to `main`, or one deleting a branch, is refused rather than held: approving would need the push to be repeated after approval |
| G9 | Codex runtime hosts outside its base egress | With an `egress` list, Codex's requests to `*.oaiusercontent.com` (OpenAI's content CDN; here the plugin list's files) are refused and noted in every task. Adding the CDN to Codex's base hosts widens every Codex agent's egress; undecided |

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

## Delivered

| # | Requirement | Where |
|---|---|---|
| R2 | Delete an agent with its tasks and VM files; workspaces untouched | #33; [Delete an agent](../AGENT_TEAM.md#delete-an-agent) |
| R4 | Skills from a URL or a local directory, given to agents in a settings panel, updated to a reviewed commit | #32; [Agent settings](../AGENT_TEAM.md#agent-settings) |
| R5 | The builder knows what exists; proposals are checked and their settings adjustable | #32; [Create agents](../AGENT_TEAM.md#create-agents) |
| R6 | Key bindings: leader key, plain keys in views, command palette, line editing, `keybindings.json` | #31; [Key bindings](../KEYBINDINGS.md) |
| R7 | Run a failed or cancelled task again, continuing its session or from scratch | #34; [Run tasks](../AGENT_TEAM.md#run-tasks) |
| G1 | git pushes of any size: streamed, their ref updates checked before the body leaves | [Limits](../AGENT_TEAM.md#limits) |
| G4 | Allow a refused egress host from the task's access view (e) or `anchi agents allow-host`; refused hosts noted in the task | [Teams, approvals, triggers and skills](../AGENT_TEAM.md#teams-approvals-triggers-and-skills) |
| G7 | Follow-ups of R8 and R9: audit rows kept with each task, alerts for a cell's own credentials, an access view across tasks (Configure → Access), quota notifications at 80% and 95% | [Access and usage](../AGENT_TEAM.md#access-and-usage) |
| R8 | Each task's external access, for the user to see: hosts, injections, credentials the cell sent, refusals, held writes, bridge calls | [Access and usage](../AGENT_TEAM.md#access-and-usage) |
| R9 | Token use per turn with totals by agent, model, runtime and day; subscription limits read by the proxy (Codex verified) | [Access and usage](../AGENT_TEAM.md#access-and-usage) |
