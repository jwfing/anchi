# Agent team phase 1 implementation plan

**Status: implemented; live acceptance in progress** (see [Status](#status)). This plan implements phase 1 of the [agent team design](AGENT_TEAM_DESIGN.md). The technical unknowns were retired by the [PoC](../../poc/README.md); this plan builds on those results.

## Goal and scope

Phase 1 delivers a TUI in which the user can:

- create agents with the agent builder;
- assign them tasks;
- watch tasks run in disposable cells, with Codex as the runtime.

The agents work against GitHub, AWS and Linear, and no upstream credential ever enters a cell.

| In scope | Deferred to phase 2 |
|---|---|
| Long-running daemon; TUI client | Claude Code runtime |
| Per-task cells on layered images | cron and polling triggers |
| Credential-injecting egress proxy | `@` delegation and orchestration, Anchi MCP server |
| Codex runtime in the cell | Full task history and process view |
| Connectors: GitHub (API + git), AWS (re-signing), Linear | Exposing the existing Gmail/Drive/Notion/Slack services to the new runtimes |
| Agent builder (configuration and image) | `ask` mode on proxy rules |
| Minimal task list: status, times, final result | Remote machines (not planned) |

## Phase 1 end-to-end acceptance

Phase 1 is done when all of the following pass on a fresh macOS install. Each must be shown with live evidence.

1. **Developer agent.** The builder creates a Codex agent with the GitHub connector and a Node toolchain image. Assigned a GitHub issue in a test repository, it:
   - clones the private repository;
   - commits a fix;
   - pushes a branch;
   - opens a PR with `gh`.

   The task list shows `done` and the PR link.
2. **DevOps agent.** An agent with the AWS connector (a dedicated least-privilege principal) reads CloudWatch logs and files a GitHub issue summarizing the errors.
3. **Linear agent.** An agent reads a Linear ticket and comments on it.
4. **Credential invariant check.** After each task above, a trusted VM script searches the destroyed cell's captured environment, process list and writable layer for the real credential values, and finds none. The scan is taken just before destruction.
5. **Isolation regression.** `make verify-vm` and the new cell/proxy checks pass:
   - no direct egress;
   - SSRF refused, including DNS rebinding;
   - minting APIs denied;
   - an agent without a connector gets no injection.

## Architecture decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Port my-bot into this repository, refactored, not copied.** A pnpm/TypeScript workspace under `anchi/`, split by trust zone. Each milestone ports the my-bot module it needs and rewrites it to Anchi's boundaries, with its tests; see [Porting my-bot](#porting-my-bot) | my-bot has a working agent model, daemon, scheduler, team MCP and Ink TUI, but assumes runtimes run on the host with the user's account directories. A copy would bring host execution, credential paths and an unauthenticated agent identity into the trusted zone |
| D2 | **The runtime SDK runs inside the cell.** A small in-cell runner (Node) hosts the Codex SDK and streams runtime events as JSON lines over a per-cell control socket. On the host, a cell runtime client takes the place of my-bot's in-process adapters | The SDK and CLI are both untrusted and both stay in the cell. The daemon only parses bounded events. This mirrors today's `pi/` bridge |
| D3 | **The proxy is mitmproxy plus the Anchi addon**, as a trusted VM service with its own UID | Proven in the PoC: TLS interception, WebSocket and HTTP/2. Python matches `services/`. Revisit only if performance or footprint requires it |
| D4 | **A cell lives for one task.** It stays alive across turns of that task and is destroyed after completion plus an idle timeout (default 10 minutes). Each agent has a persistent volume holding its workdir and runtime state (`CODEX_HOME` sessions, without auth) | Follow-up messages reuse the cell. A new task starts clean, and the agent's repositories and dependency caches persist |
| D5 | **Credentials live in the existing `secure-auth` vault.** The proxy UID obtains them over the auth socket, verified by `SO_PEERCRED`. Codex token refresh reuses the existing trusted Codex administration | Reuses the encrypted-at-rest, host-held-key design. There is no second credential store |
| D6 | **Codex runs `danger-full-access`; the cell is the boundary.** The bwrap `userns` AppArmor profile is a per-agent opt-in | Decided after the PoC |
| D7 | **Freeze the Electron desktop app and Pi.** They keep working until the daemon reaches parity for setup, then are retired. Existing connector services stay deployed but are not wired to the new runtimes in phase 1 | Avoids two control planes evolving at once |

D1–D4 were confirmed on 2026-10-06. D5–D7 follow from earlier decisions.

## Milestones

Sizes: S ≤ 3 days, M ≈ 1 week, L ≈ 2 weeks, for one developer. The guest-side milestones (M1, M2) and the host-side milestones (M3, M4) can run in parallel after M0.

```text
M0 ─┬─ M1 cells ────┬─ M3 Codex runtime ─┬─ M5 TUI ─┬─ M7 builder ── acceptance
    ├─ M2 proxy ────┤                    │          │
    └─ M4 daemon ───┘                    └─ M6 AWS + Linear
```

### M0 — Workspace and contracts (S)

- Create the `anchi/` pnpm workspace with the package split below: TypeScript, Vitest, Prettier. Wire it into `make check` and CI.
- Port the trusted foundations from my-bot, refactored:
  - the agent schema and loader, with my-bot's account and access fields removed and Anchi's fields added: `connectors[]`, `image`, `network` (reserved) and `sandbox` (`cell` | `codex-workspace-write`);
  - the bounded JSON-lines codec, used by every socket.
- Write down the contracts that later milestones code against, as types plus zod schemas in `@anchi/protocol`:
  1. **Daemon ⇄ client:** JSON-RPC plus an event stream over a Unix socket.
  2. **Daemon ⇄ guest administration:** fixed, allowlisted commands over Lima SSH, as today.
  3. **Cell runner ⇄ daemon:** runtime events as JSON lines, validated, with per-frame and per-turn byte limits.

**Acceptance:**

- `make check` runs the TypeScript tests, including the ported schema and loader tests.
- A dependency check fails if a host package imports `@anchi/cell-runner` or a runtime SDK.
- The schema and protocol documents are in `docs/architecture/`.

### M1 — Task cells (M)

- Replace the fixed-unit `guest/cell-run` with a task-cell manager (guest root). Its commands are `start TASK AGENT IMAGE`, `exec`, `stop` and `list`. The unit name is per task; the existing resource limits stay.
- Images: one shared base, a per-agent upper layer, and a `--volatile=overlay` top layer (all proven in the PoC). Store image metadata (source, build log, size) next to each layer.
- Mounts:
  - `/run/anchi/cells/<task>/` contains the proxy socket and the control socket, bound into that cell only;
  - the agent's persistent volume is mounted at `/home/agent`.
- Concurrency limit and idle reaper. Cleanup must be correct after a daemon crash: list orphaned cells and unmount stale overlays.

**Acceptance:**

- Two cells run concurrently, and neither can see the other's sockets, files or processes.
- Start-to-exec takes under 100 ms, excluding the runtime.
- Killing the daemon leaves no mounted overlay after the reaper runs.

### M2 — Egress proxy service (L)

- Productionize `poc/egress-proxy/anchi_inject.py` as `services/egress_proxy/`:
  - a dedicated UID and systemd unit;
  - an nftables rule for that UID that rejects private ranges.
- **Cell identity:** the proxy maps each per-cell socket to a task and agent. A trusted bridge listens on each cell's socket and tags connections for mitmproxy. The tagging mechanism (per-cell listen port vs. trusted connection metadata) is chosen at the start of M2.
- Rule engine:
  - rules are evaluated per agent from its `connectors`;
  - **replace-only** for runtime APIs, unconditional injection for git smart HTTP;
  - path scopes, deny lists, and AWS-shaped denials;
  - unsigned requests pass through.
- Destination filtering that **connects to the checked address**, keeping SNI and the Host header. This closes DNS rebinding.
- Credentials fetched from `secure-auth` (D5), never from environment variables. Audit log: method, host, path, operation, decision, task and agent; never header values.
- GitHub rules: API bearer and git Basic. The deny list includes key creation, installation tokens and Actions secrets.

**Acceptance:**

- PoC checks ported to `tests/`.
- A live check clones a **private** repository and **pushes** a branch from a cell.
- A rebinding test (DNS answer changes between check and connect) is refused.
- An agent without `github` gets no injection.

### M3 — Codex runtime in the cell (M)

- In-cell runner (`anchi/cell-runner/`) hosts the Codex SDK and handles `run`, `cancel` and `resume` over the control socket.
- **Codex image recipe** (from the PoC):
  - the full `codex-package-<target>`;
  - `codex-linux-sandbox` alias, `/home/agent`, CA trust and proxy profile;
  - placeholder `auth.json` carrying the real account id.
- `CellRuntimeAdapter` in the daemon: start or reuse the task cell, stream events, map cancellation, apply a turn timeout.
- **Account import:** read the host Codex login once with user consent and store it in the vault. The trusted side refreshes it. The cell gets the account id only.

**Acceptance:**

- A multi-turn task with tool calls runs in one cell.
- Cancellation stops the turn within 5 s.
- A follow-up after the idle timeout resumes in a new cell from the persistent session.

### M4 — Daemon core and minimal task list (M)

- Port my-bot's hub as the daemon core: agent registry, per-agent run queue, notifications. Runs go to the cell runtime client; there is no host execution of runtimes.
- **Task store** (SQLite under the daemon data directory):
  - task id, agent, trigger, status;
  - start and end times, final result text, links;
  - a bounded event log for the current session view.
- Move setup from `desktop/src/main` into the daemon, behind the same fixed-command allowlist:
  - dependency checks, VM install and start;
  - vault init and unlock;
  - Codex login import.

**Acceptance:**

- With the TUI closed, a task submitted through the protocol runs to completion. Reopening shows its status and result.
- Daemon restart recovers the task list and reaps orphaned cells.

### M5 — TUI (M)

- **First task: the CJK IME check** in the my-bot TUI as it is today, before porting it. Test long Chinese input, editing and cursor position in Terminal.app, iTerm2 and Ghostty. If any fails, add an `$EDITOR` compose fallback before building further.
- **Layout:** the left menu holds runtimes, skills (placeholder), connectors and builder above the agent list; the main pane is chat. Add a task list view.
- **Security requirements:**
  - strip control characters and ANSI/OSC sequences from all agent-originated text;
  - security confirmations use full-screen modals;
  - secrets use masked input that agent content cannot draw over.
- **Connector setup screens:**
  - GitHub: import from `gh auth token` with consent, or paste a fine-grained PAT;
  - AWS: dedicated access keys or SSO profile;
  - Linear: API key.

  All values go to the vault through the daemon.

**Acceptance:**

- Escape-injection tests: OSC 52, OSC 8, clear screen and a fake approval box are all neutralized.
- Every connector can be connected and disconnected from the TUI.

### M6 — AWS and Linear connectors (S + S)

- **AWS:**
  - port the re-signing and the query/JSON/REST operation extraction;
  - deny STS and IAM credential minting;
  - support a session token and SSO profiles refreshed on the trusted side;
  - document the dedicated-principal requirement in the connector setup screen.
- **Linear:** an injection rule for `api.linear.app`, with a placeholder `LINEAR_API_KEY` in the image. The in-cell client is an off-the-shelf Linear MCP server or CLI that reads the key from the environment; it is chosen at the start of M6.

**Acceptance:** acceptance scenarios 2 and 3 pass.

### M7 — Agent builder (M)

- The builder is a Codex agent in a cell with a builder skill. It outputs a candidate agent YAML plus an image recipe (base packages, tool installers).
- The daemon validates the schema, shows a diff of prompt, connectors, image and sandbox, and requires confirmation in a modal.
- The image is built in a build cell with proxy egress and no injection rules, with a logged build. Any change to the recipe needs confirmation again.
- The builder cannot modify any agent configuration directly, including its own.

**Acceptance:** scenario 1 starts from a builder conversation, with no hand-edited YAML.

## Status

All milestones are implemented on the `feat/agent-team-phase1` branch. The [agent team guide](../AGENT_TEAM.md) covers usage.

| Milestone | State | Evidence |
|---|---|---|
| M0 | Done | `anchi/` workspace in `make check`; trust-zone dependency check; [contracts](AGENT_TEAM_CONTRACTS.md) |
| M1 | Done | `make verify-anchi`: concurrent isolated cells; nspawn start-to-exec about 36 ms (60–75 ms including the manager); no overlay left after the reaper |
| M2 | Done; private push pending | `make verify-anchi`: no direct egress, SSRF and DNS rebinding refused, minting denied, no injection without a connector. `tests/test_egress.py` holds the ported PoC checks. Live on 2026-10-07: a Codex agent without a connector cloned a public repository through the proxy, and its push got no credential (`pass:not-granted`). Keep-alive clients reuse upstream connections (a Node image builds in 29 s); connector credentials are verified at import |
| M3 | Done | Live on 2026-10-07: a multi-turn Codex task in one cell, a follow-up resumed in a new cell after the first was stopped, and a cancelled turn that released its cell. `anchi scan` found no real credential in the cell |
| M4 | Done | Daemon tests: task store, cell reuse and idle timeout, restart recovery and reaping |
| M5 | Done; IME check pending | TUI tests: OSC 52, OSC 8, clear screen and a fake approval prompt are neutralized; secrets are masked; IME-committed CJK input is sent intact and deleted by character |
| M6 | Done; live checks pending | AWS re-signing and denials tested offline; Linear injection rule |
| M7 | Done | Live on 2026-10-07: the builder proposed a `pydev` agent and a Python image; the applied proposal wrote both files, the image was built on first use (64 s, 9 MB layer), and the agent ran and passed its pytest task |

Decisions taken during implementation:

- **Runner control channel (M1, M3):** the runner's stdin and stdout, carried by `anchi-cell start` over `limactl shell`, replace a per-cell control socket. This is the same pattern as the Pi bridge. Closing the channel ends the cell, so a lost daemon cannot leave a runner waiting.
- **Cell identity (M2):** the proxy hosts each cell's socket itself. Its in-process bridge binds a loopback port, maps the port to the cell, and only then connects to mitmproxy, so every client connection is attributed before its first byte. Connections that do not come from a bridge are refused.
- **Codex account (M3):** the vault receives the access token and the account id only. The refresh token stays with the Codex CLI on the Mac, which refreshes it. When the vault's token expires, the user imports it again, and the proxy refuses to serve an expired token. This keeps a rotating refresh token from being shared by two refreshers.
- **Linear client (M6):** agents call the GraphQL API with `curl`, using the placeholder `LINEAR_API_KEY`; the environment note in every agent's instructions explains this. There is no extra package to pin.
- **Builder output (M7):** the builder ends its reply with fenced `anchi-agent` and `anchi-image` blocks. The daemon parses and validates them and shows a diff. It writes the files only after a `y` in the full-screen dialog.

## Porting my-bot

my-bot (`../my-bot`, about 3,500 lines of TypeScript) is the starting point for the host side. It is ported module by module, not imported as a whole.

### Package split

| Package | Zone | Contents | Must not depend on |
|---|---|---|---|
| `@anchi/protocol` | Shared | Event and RPC types, zod schemas, bounded JSON-lines codec | Anything else in the workspace |
| `@anchi/core` | Host, trusted | Agent schema and loader, data directory layout, SQLite store | Runtime SDKs, `cell-runner` |
| `@anchi/daemon` | Host, trusted | Hub, task store, scheduler, cell and proxy control, client socket | Runtime SDKs, `cell-runner` |
| `@anchi/tui` | Host, trusted | Ink client | Runtime SDKs, `cell-runner` |
| `@anchi/cell-runner` | Cell, untrusted | Runtime adapters (Codex SDK; Claude Agent SDK in phase 2) | Host packages |

The host packages never load a runtime SDK. The cell runner is built into the agent image and only shares `@anchi/protocol` with the host.

### Module map

| my-bot module | Phase 1 handling | Milestone |
|---|---|---|
| `core/config/schema.ts`, `loader.ts` | Port. Keep `extends` templates and layer merging. Remove `account`, `workspace.access`, `workspace.extraDirs`, `workspace.network` and `tools.allow`/`deny`; add Anchi's fields. Rename bot to agent | M0 |
| `daemon/rpc.ts` | Port the codec with a maximum frame size, and drop invalid frames with an error instead of skipping them silently | M0 |
| `daemon/protocol.ts`, `core/events.ts` | Port as `@anchi/protocol` with zod schemas. Remove `permission.decided` and the permission methods; Codex runs with no in-runtime approvals (D6) | M0 |
| `core/runtime/codex.ts` | Move to `cell-runner`. It receives no host environment and no `CODEX_HOME` containing auth | M3 |
| `core/runner.ts` | Port session selection and the prompt-hash rule into the daemon. Replace adapter calls and `runtimeEnv` with the cell runtime client | M3, M4 |
| `core/store.ts` | Port sessions and events, add the task table, and cap stored event size | M4 |
| `daemon/hub.ts`, `daemon.ts`, `scheduler.ts` | Port the per-agent queue, interrupt and status model. The scheduler stays unused until cron in phase 2 | M4 |
| `daemon/launch.ts`, `notify.ts` | Port: launchd user agent and desktop notifications | M4 |
| `cli/tui/*` | Port with the security requirements of M5 (escape stripping, modals, masked input) | M5 |
| `core/env.ts` | **Drop.** Login-shell capture and account directories are host-execution concerns. Cells get a fixed environment from their image | — |
| `core/runtime/claude.ts` | Phase 2, into `cell-runner` | — |
| `daemon/team.ts` | Phase 2, redesigned. Its caller identity is a URL path plus one token shared by every agent, so any agent could act as another. In Anchi the caller is the cell its control socket belongs to | — |
| `daemon/telegram.ts` | Not planned. A Telegram channel would need its own credential handling | — |
| `cli/accounts.ts`, `detect.ts`, `init.ts`, `doctor.ts` | Replaced by daemon setup (M4) and connector screens (M5) | — |

Ported files keep a note of their my-bot origin in the commit message, not in the code. my-bot itself stays unchanged.

## Cross-cutting work

- **Tests.** Offline unit tests for every trust-boundary decision: rules, deny lists, destination filtering, schema validation, escape stripping and protocol limits. Live checks go into `scripts/verify.sh` and `make verify-vm`, kept separate from `make check`.
- **Documentation.** As milestones land, move content from the design document into `SECURITY.md`, `docs/SECURITY_FOUNDATION.md` and `docs/architecture/REPOSITORY.md`. In particular, `SECURITY.md` must state that unmatched egress means **credential isolation is not data isolation**.
- **Migration.** Existing users keep the desktop app until M4 reaches setup parity. The VM gains the new services without removing the existing ones in phase 1.

## Risks

| Risk | Mitigation |
|---|---|
| Codex or Claude Code releases change endpoints, helper binaries or auth checks (the PoC already hit three such issues) | Pin runtime versions per image. A live smoke test (`run-codex` equivalent) gates version bumps |
| mitmproxy footprint or edge cases (HTTP/2, large uploads) | Keep the addon logic independent of mitmproxy so the proxy can be replaced; load-test git clone of a large repository in M2 |
| Ink TUI CJK input is poor | First task of M5, with an `$EDITOR` fallback |
| Per-cell identity tagging is more complex than expected | Decide at M2 start. Fallback: one mitmproxy listen port per cell, behind the trusted bridge |
| Image size: Codex package 519 MB with unused voice libraries | Shared base layer for runtimes; strip `codex-resources/voice` in the recipe |
| Subscription terms for distribution | Unchanged from the design; revisit before any public release |
