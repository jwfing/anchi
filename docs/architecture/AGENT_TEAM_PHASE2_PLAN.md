# Agent team phase 2 implementation plan

Phase 1 is merged (PR #27): daemon, TUI, task cells, the egress proxy, the Codex runtime, GitHub/AWS/Linear connectors and the agent builder. Its live acceptance with real accounts is still open and is tracked in the [phase 1 plan](AGENT_TEAM_PHASE1_PLAN.md#status). This plan covers phase 2 of the [design](AGENT_TEAM_DESIGN.md#phases).

## Goal and scope

Phase 2 turns single agents into a team that works without the user starting every task:

- a second runtime, **Claude Code**;
- an **Anchi MCP server** in every cell, the one way an agent reaches Anchi itself;
- **delegation** between agents through that server;
- **triggers**: cron schedules and connector polling;
- the existing **Gmail, Drive, Notion and Slack** connectors, available to the new runtimes;
- **approvals**: `ask` mode on proxy rules and connector writes, decided in the TUI;
- a **full task list**: history, search, the delegation tree and deletion;
- **skills** assigned per agent.

| In scope | Not in phase 2 |
|---|---|
| Claude Code runtime (subscription token, API key optional) | Remote machines (not planned) |
| Anchi MCP server and delegation with depth and budget limits | A2A exposed outside the daemon |
| Cron and polling triggers | Telegram or mobile notifications |
| Gmail/Drive/Notion/Slack through the MCP server | New connectors beyond these four |
| `ask` approvals in the TUI | A GUI client |
| Task history, search, tree, deletion, retention | Host-mounted work directories |
| Skills from GitHub or local directories | A public skill registry |
| Retiring the Electron app and Pi | |

## Phase 2 end-to-end acceptance

Each must be shown with live evidence, as in phase 1.

1. **Claude Code agent.** The builder creates a Claude Code agent with the GitHub connector. It fixes an issue and opens a PR. The cell holds only a placeholder token, and the credential scan is clean.
2. **Delegation.** A `lead` agent receives "triage the newest Linear issue and fix it". It delegates the fix to `developer` with `delegate_task`, gets the PR link back and comments it on the Linear issue. The task list shows the parent task with its child.
3. **Triggers.** A cron agent posts a daily summary to Slack. A polling trigger starts a task for each new Linear issue with a given label, exactly once per issue, across daemon restarts.
4. **Existing connectors.** An agent reads Gmail and creates a Notion page through the MCP server. The Notion write waits for approval in the TUI and runs only after `y`.
5. **Approvals.** With `github` writes in `ask` mode, `git push` and `gh pr create` from a cell wait for a TUI approval; denying returns an error to the agent, and nothing reaches GitHub.
6. **Isolation regression.** `make verify-anchi` passes, plus new checks:
   - the MCP server cannot reach another agent's tasks or connectors;
   - delegation depth and budget limits stop a loop;
   - an agent without a connector cannot call its MCP tools.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| E1 | **Anchi's own tools (delegation, task status) reach the daemon over the runner's existing stdio channel.** A stdio MCP server in the cell (`/opt/anchi/mcp.mjs`, started by the runtime) connects to the runner over a cell-local Unix socket; the runner forwards tool calls to the daemon as new frame types, and the daemon answers | The daemon already knows which cell, task and agent a runner belongs to, so every call carries a trustworthy identity. No new socket crosses the VM boundary for these tools |
| E2 | **Gmail, Drive, Notion and Slack: the agent's own connector sockets are bound into its cell.** The cell manager binds `/run/secure-<id>` read-only at `/run/anchi-connectors/<id>` only for the connectors the agent has; the in-cell MCP server exposes their operations as tools. The services stay unchanged: policy, frozen content, one-time grants and the daily write limit. A write the policy holds is shown in the TUI after the daemon verifies it with the policy service | Chosen on 2026-10-07 over routing connector calls through the daemon. Per-agent scoping comes from the mounts. The services identify the caller by UID, and all agent cells share it, so their policy mode (`auto` or `ask`) is per connector, not per agent; agent `approvals` therefore cover the proxy connectors only |
| E3 | **Approvals move to the daemon.** Proxy rules and connector writes in `ask` mode create a pending approval; the TUI shows it in a full-screen modal, and a desktop notification fires when the TUI is closed. The proxy holds the request (up to a timeout) while it waits | One approval queue for both mechanisms. Holding the request keeps `git push` and `gh` working unchanged; the timeout (default 5 minutes) fails the request with a clear error |
| E4 | **Polling runs in the trusted VM, not in cells.** A small trusted poller (`anchi-poll`, under the egress UID) calls one fixed read-only query per trigger type (Linear issues by filter, GitHub issues or PRs by query) with vault credentials and reports new item ids to the daemon. Cron needs no VM side | Polling every few minutes in a fresh cell would start hundreds of cells a day. The poller can only run fixed queries, so it adds no new capability |
| E5 | **Claude Code uses a `claude setup-token` subscription token by default**, injected replace-only on `api.anthropic.com`, the same way as in the PoC. API key mode is an alternative per agent. Before public distribution, subscription mode is revisited (see [Known risks](AGENT_TEAM_DESIGN.md#known-risks)) | Verified in the PoC, including tool use. Matches the Codex model: the cell holds a placeholder |
| E6 | **Retire the Electron app and Pi in this phase**, after the daemon covers their remaining setup (Google OAuth for Gmail and Drive, Notion and Slack tokens) | D7 of phase 1 froze them until the daemon reached parity; Google OAuth is the last missing piece. Two control planes would otherwise drift |

E1–E6 were confirmed on 2026-10-07; E2 as revised above.

## Milestones

Sizes as in phase 1: S ≤ 3 days, M ≈ 1 week, L ≈ 2 weeks.

```text
N0 ─┬─ N1 Claude Code ───────────────────────────────┐
    ├─ N2 MCP server ─┬─ N3 delegation ─┬─ N6 tasks ─┼─ acceptance
    │                 └─ N4 connectors ─┤            │
    └─ N5 approvals ────────────────────┘            │
       N7 triggers (after N2) ─── N8 skills ── N9 retire Electron/Pi
```

### N0 — Contracts (S)

- Agent schema:
  - `runtime: codex | claude-code`;
  - `connectors` gains `gmail`, `drive`, `notion`, `slack`;
  - `delegates: [agent ids]` (who this agent may delegate to);
  - `triggers` (`schedule` cron expression, or `poll` with a type and filter);
  - `skills: [ids]`;
  - `approvals` (per connector: `auto` or `ask`, with per-operation overrides).
- Runner protocol v2:
  - `tool.request` and `tool.response` frames for MCP calls;
  - `approval.wait` notices, so the transcript shows what the agent is waiting for.
- Daemon RPC: approvals, triggers, task search and deletion, skills.
- [Contracts](AGENT_TEAM_CONTRACTS.md) updated.

### N1 — Claude Code runtime (M)

- Image: the Claude Code package in the base layer next to Codex, pinned by version and hash. Placeholder `CLAUDE_CODE_OAUTH_TOKEN`.
- Runner: a Claude Agent SDK adapter beside the Codex one, mapping its events to the same runtime events; resume by session id.
- Proxy: an `anthropic` rule, replace-only on `api.anthropic.com`. Vault: a `claude` runtime account imported with `anchi setup claude` (paste the `setup-token` output, masked) or an API key.
- Builder: can propose `runtime: claude-code`.

**Acceptance:** scenario 1; a multi-turn Claude Code task with resume in a new cell.

### N2 — Anchi MCP server (M)

- `/opt/anchi/mcp.mjs`: a stdio MCP server, registered with both runtimes in the cell's configuration. It holds no credentials and only relays to the runner (E1).
- Daemon: a tool dispatcher with per-call validation (zod), per-agent tool lists and per-task call budgets.
- First tools: `anchi_whoami` (agent and task) and `list_agents` (only the agent's `delegates`).

**Acceptance:** both runtimes list and call the tools; a forged frame for another task is rejected.

### N3 — Delegation (M)

- Tools: `delegate_task(agent, text)` (waits for the child's result, with a timeout), `start_task` (returns the id), `task_status(id)` and `send_to_task(id, text)`, all limited to the agent's `delegates` and its own children.
- Task store: `parent_id`, `depth`, `root_id`; limits on depth (default 3), children per task and total turns per tree.
- The TUI shows a delegation as a collapsible line in the parent's transcript, like tool groups.

**Acceptance:** scenario 2; a delegation loop stops at the depth limit.

### N4 — Existing connectors through MCP (M)

- Per-cell connector sockets (E2): the bridge, its registration with the cell, and principal handling in the connector services (`agent:<id>`, accepted only from the bridge UID).
- MCP tools generated from the connector operation table (`gmail.list`, `notion.create_page`, …), offered only for the agent's connectors.
- Writes that need approval return `APPROVAL_REQUIRED:<id>`; the daemon shows the pending grant (N5), and the MCP tool retries once it is decided.

**Acceptance:** scenario 4.

### N5 — Approvals (M)

- Proxy: `mode: ask` on rules and per operation; the proxy asks the daemon over the control socket and holds the request.
- Daemon: approval queue in SQLite, timeouts, notifications; RPC `approvals.list`, `approvals.decide`.
- TUI: an approvals entry in the sidebar with a count, and a full-screen modal showing agent, task, operation and the exact payload.
- Defaults: `ask` for `git push` to protected branch names, PR merges, AWS writes and all connector writes; `auto` otherwise.

**Acceptance:** scenario 5.

### N6 — Full task list (M)

- Search by agent, status, text and date; the delegation tree; per-task cost and duration (tokens and turns from `usage` events).
- Deletion of a task and its events; retention setting (default 90 days).
- TUI: a filter line over the Tasks section and a tree view in the task detail.

### N7 — Triggers (M)

- Cron: `triggers: [{schedule: '0 9 * * 1-5', text: …}]`, run by the daemon; missed runs while the Mac slept run once on wake.
- Polling (E4): Linear issues by team, label or state; GitHub issues or PRs by search query. At-least-once detection, exactly-once task creation, keyed by item id in the task store.
- TUI: triggers listed per agent, with the next run and the last result.

**Acceptance:** scenario 3.

### N8 — Skills (S)

- `~/.anchi/skills/<id>/SKILL.md`, added from a GitHub URL (fetched once, pinned by commit) or a local directory.
- Copied read-only into the cell at task start; both runtimes load them (`.claude/skills`, Codex instructions).
- The TUI Skills screen lists, adds and removes skills; the builder can assign them.

### N9 — Retire Electron and Pi (M)

- Daemon setup gains Google OAuth (loopback) for Gmail and Drive, and Notion and Slack tokens.
- Remove `desktop/`, `pi/` and their services after a release that warns about it; keep the connector services.

## Risks

- **Privilege borrowing grows with delegation and triggers.** A polled Linear issue can now reach a high-privilege agent without the user. `ask` defaults for writes (N5) and `delegates` allowlists are the mitigation.
- **Claude subscription terms** (E5).
- **Holding proxied requests for approval** can break clients with short timeouts. Measured per client in N5; `git` and `gh` are the priority.
- **Polling credentials** live in a new trusted component (E4); it must stay limited to fixed queries.
