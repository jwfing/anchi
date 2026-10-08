# Backlog

Requirements recorded but not yet planned into a phase. Each entry has the request, what exists today (checked against the code on 2026-10-08) and the open questions to settle before planning.

| # | Requirement | State |
|---|---|---|
| R1 | Preview the files an agent changed, through a plugin | Not started; plugin design needed |
| R2 | Delete an agent | Not started |
| R3 | Start a new session for an agent ("new chat") | Exists as `^X` and `/new`; not discoverable |
| R4 | Add skills from a URL or a local directory | Exists in the CLI and the TUI; assigning skills to agents is missing |
| R5 | Skills, connectors and workspaces in the agent builder | Partly: the builder ignores skills and does not know what exists |

## R1 — File preview through a plugin

**Request.** When an agent develops, the transcript says which files it touched. Being able to list and preview those files, which live in the VM, would help a lot. Build it as a plugin, after the model of [herdr plugins](https://herdr.dev/docs/plugins/) and [herdr-file-viewer](https://github.com/smarzban/herdr-file-viewer); reusing herdr or other third-party plugins would be best.

**Today.**

- No file-change event: a Codex `file_change` becomes a generic `tool.call` named `apply_patch` whose result is one `<kind> <path>` line per file (`cell-runner/src/codex.ts`); Claude `Edit`/`Write` are generic tool calls with their JSON input (`cell-runner/src/claude.ts`). The TUI summarizes only `command`, `path`, `query` and `url`, so both show as truncated JSON (`tui/src/tui/lines.ts`).
- No RPC, CLI or TUI view lists or shows files of an agent's home or workspace. The guest has `anchi-cell exec <task> -- <cmd>` (nsenter into a live cell as the agent user); the daemon does not use it. `limactl shell` reaches the VM, not a cell.
- No plugin mechanism in the daemon or the TUI.

**herdr's model, for reference.** A plugin is a directory with `herdr-plugin.toml` declaring `[[actions]]`, `[[panes]]`, `[[events]]`, `[[build]]` and `[[link_handlers]]`. Panes are terminal processes that herdr places as a split, tab, popup or overlay; plugins get `HERDR_*` environment variables (socket, pane, context JSON) and call back through the herdr CLI or socket. No sandbox: a plugin is trusted like an editor extension. herdr-file-viewer is a Rust/ratatui, read-only, git-aware viewer (MIT) that browses a local directory and renders diffs, Markdown and code.

**Open questions.**

1. **Where the viewer runs.** The files are in the VM (agent home `/var/lib/anchi/agents/<id>/home`, live cells) or under `~/AnchiWorkspaces`. Options: run a viewer inside the VM as an unprivileged user over `limactl shell` and hand it the terminal (like `^E` for the editor); copy a snapshot to the host; or an Anchi-native view fed by an RPC (`files.list`, `files.read`) with bounded, sanitized output.
2. **Reuse herdr-file-viewer?** The Anchi TUI is an Ink app, not a terminal multiplexer, so herdr panes cannot be embedded. It could run full-screen in place of the TUI, inside the VM against the agent's directory. herdr-specific actions and its CLI callbacks would not work.
3. **Trust.** Plugins are trusted code. The content they render is untrusted (agent-written): a viewer must not run anything from it, and anything on the host must not follow links out of the agent's directory. Never run a plugin with access to the vault or credentials.
4. **Plugin manifest for Anchi.** Which entry points (a key action on a task, a full-screen view, a transcript link handler), what context (agent, task, paths from the turn), and how it is installed (`anchi plugin install owner/repo`, pinned by commit like skills).
5. **A file-change event** in the runner protocol (path, kind, diff stats), so the transcript lists changed files and a viewer can open them directly.

## R2 — Delete an agent

**Request.** Allow deleting agents.

**Today.** No RPC, CLI command or TUI key. Removing the YAML by hand makes the agent unknown, but its tasks and events stay in the store, its VM home and skills copy stay, and a running or queued agent is kept in memory until idle.

**Open questions.** Refuse while tasks run, or cancel them; delete or keep its tasks and transcripts (as `anchi rm` does for tasks); delete its VM home (work directory, Codex and Claude sessions); clear its policy rules (`notion:<agent>`) and its trigger state; what happens to agents that list it in `delegates`, and to an agent that `extends` it as a template.

## R3 — New session for an agent

**Request.** Not always appending messages to one task: an explicit "create a task from scratch", like ChatGPT's new chat. A follow-up continues the task's session; a new task starts a new session.

**Today.** `^X` and `/new` in an agent's chat make the next message create a new task, which starts a fresh Codex thread or Claude session (sessions are per task: `resume_id` on the task). Follow-ups go to the task shown. The CLI has `anchi run` (new task) and `anchi send` (follow-up). Not separate: the agent's home is shared by all its tasks, including `/home/agent/work` and the runtimes' session files.

**Open questions.** Make "new task" visible (a button or line in the chat header, the footer hint, the help); show which task a message will go to; whether a new task should also start from a clean work directory (per-task directories, or an option).

## R4 — Add skills from a URL or a local path

**Request.** Adding skills is not supported yet; it should accept a URL or a local directory.

**Today.** Supported: `anchi skills add <source> [--id]` and the TUI **Skills** screen (`a`) accept a GitHub tree URL (pinned to the commit) or a local directory; `anchi skills rm` and `d` remove one. Limits: 200 files, 4 MB, no symlinks. Missing: assigning a skill to an agent from the TUI (only `skills: [id]` in the agent YAML); URLs other than GitHub (other git hosts, archives); updating a URL skill to a newer commit; choosing the id in the TUI.

**Open questions.** Which URL forms to accept; whether adding a skill should offer to assign it to agents at once.

## R5 — Skills, connectors and workspaces in the agent builder

**Request.** When the builder creates an agent, there seems to be no way to give it skills, connectors or a local work directory.

**Today.** The builder's instructions describe connectors, workspaces, egress, approvals, delegates, image and sandbox, but not `skills` or `triggers`. The schema accepts them all, so a proposal that included them would apply. The builder is told nothing about what exists: installed skills, connected connectors, other agents, images, or directories under `~/AnchiWorkspaces`. Proposals are not checked for skills, delegates or workspaces that do not exist.

**Open questions.** Give the builder an inventory (skills, connected connectors, agents, images, workspace directories) at the start of each turn; check references in proposals and show missing ones in the proposal dialog; whether the proposal dialog should let you toggle skills, connectors and workspaces directly instead of asking the builder again.
