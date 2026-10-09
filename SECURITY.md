# Security model and reporting

Anchi is meant to be a secured agent team: agents that act on your accounts without ever holding their credentials, each limited to what it is configured with, with your approval in front of the writes that matter. This page states which boundaries hold and where they stop.

This is a development project. It has not completed a security audit and is not claimed suitable for unattended processing of sensitive real accounts.

## Trust boundaries

- **Untrusted:** everything inside a cell: the runtime (Codex, Claude Code), its tools and processes, the cell runner and the in-cell MCP server, skills, session files and model output.
- **Trusted:** the host OS and administrator, the Anchi daemon, TUI and CLI (`anchi/packages/{core,daemon,tui,protocol}`), the host scripts, guest administration, and the vault, auth, policy, connector and egress services.
- Upstream credentials never enter the cell. External policy and connectors control requested operations. Hiding keys does not prevent every misuse of an otherwise valid interface.
- Read content may enter agent context and cloud models. Credential isolation must not be described as keeping sensitive content on the host.
- Clients strip control characters and escape sequences from agent text. Security decisions (builder proposals, agent settings changes, agent deletion, approvals, setup steps, secret input) use full-screen dialogs drawn by Anchi that agent output cannot reproduce. Agent files change only after such a dialog shows the diff, or by your own edits.

## Authorization modes

Policy stores a mode for each connector service (Gmail, Drive, Notion, Slack), and optionally one per agent and service (`notion:<agent>`) that an agent's `approvals: {notion: ask}` sets. Agent writes through the egress proxy (GitHub, AWS, Linear) follow the agent's `approvals` and the high-risk list; see the agent team section below.

- **`auto` (default, standing authorization):** connecting authorizes use. Allowlisted operations and parameters receive one-time grants automatically; reads and writes are audited without a human click.
- **`ask` (per-request approval):** each operation requires independent review of the normalized full action and digest. Approval applies only to that exact content and expires if not granted within ten minutes.

Older policy databases without an explicit new mode also default to `auto`; explicit modes are retained. A legacy read-only grant is not equivalent to the new standing read/write mode. Review the permissions page after upgrading.

Both modes retain these constraints: credentials stay outside the cell; connector operation/path allowlists and size limits still apply; updates bind to a current target revision and recheck before writing (`TARGET_CHANGED`); each connector allows at most 200 writes daily; uncertain outcomes are not retried; policy decisions and execution are audited. Mode changes increment the policy epoch and revoke all unconsumed grants.

Standing authorization accepts prompt-injection risk: instructions embedded in mail, files, pages or messages can cause an agent to write without an intervening human gate. The remaining controls are the allowlists, revision checks, quotas and audit above. Use per-request approval when you want to inspect each operation.

In either mode, an agent's own tool calls inside its cell (shell, files, network through the proxy) run without individual approval; the cell is the boundary.

## Authentication and connectors

The Codex login is imported from the host's `~/.codex/auth.json`, by the user or automatically when the host's Codex CLI refreshes it: only the access token and account id go to the vault, over stdin; the refresh token stays on the host.

Google sign-in uses the system browser, an ephemeral `127.0.0.1` port opened by the daemon, state and PKCE. Google tokens enter only the VM authentication layer. Invalid refresh credentials set reauthentication-required and stop further Google requests until the user reconnects. Gmail has no task-scoped sender/folder restrictions. Cancelling a local task cannot withdraw an upstream request or automatically revoke pending approvals.

Drive, Notion and Slack follow the Gmail service boundary: separate UIDs and sockets, provider-specific TCP 443 egress and registry-defined read/write operations. Both reads and writes follow the configured authorization mode. In `ask`, the complete write content is frozen for review. Static Notion/Slack tokens are entered without echo in the CLI or a masked full-screen dialog in the TUI, and go to the vault over stdin. Notion has no remote token-revocation API. A cell reaches only its agent's connector services, through a bridge in `anchi-egress` that names the agent (`notion:<agent>`) on every request; the services accept a named agent only from the bridge's UID, and a cell never sees a service socket itself. An agent's `approvals: {notion: ask}` holds its writes, not its reads; the service-wide mode still applies to every agent, and the daily write limit stays per service.

Approval waits retain the same request. Frozen actions persist; target preparation does not hold a database write lock. Frozen content is retained for at most seven days while execution records remain for replay protection. Write quota is reserved before preparation. Uncertain remote outcomes are UNKNOWN. Read-only POST operations such as Notion search are not treated as writes.

Drive text updates require a nonempty revision and recheck it immediately before writing. `If-Match` is sent only when a strong ETag exists; ETags are not mandatory. Without an ETag, the revision precheck has a check/write race. Notion's edit-time check has the same limitation. Neither is atomic concurrency control. Google Docs overwrite is refused; read and create remain available.

## Agent team: task cells and the egress proxy

The agent team (`anchi/`, `guest/anchi_cell.py`, `services/egress_*.py`) runs Codex and Claude Code agents in per-task cells. Its boundaries:

- **Credentials never enter a task cell.** Cells hold placeholders and the Codex account id, which is an identifier rather than an authenticator. The `anchi-egress` proxy reads GitHub, AWS, Linear and Codex credentials from `secure-auth`, whose kernel-UID check limits them to that service, and injects or re-signs them on matching requests. It never adds a runtime credential to a request that did not carry a placeholder. Token refresh happens on the trusted side.
- **Credential isolation is not data isolation.** Unmatched traffic passes through the proxy unchanged so agents can install packages and read the web; an agent's `egress` list, when set, limits which hosts that traffic may reach (checked when the proxy opens the upstream connection). An agent can send anything it can read to any public host. Connectors grant their full upstream authority, minus the deny lists, so use a dedicated least-privilege principal for AWS and a fine-grained, repository-scoped token for GitHub.
- **Destinations are filtered.** The proxy refuses non-public addresses and connects to the address it checked, so DNS rebinding cannot redirect it. The nftables rules for the proxy UID reject private ranges as a backstop. Cells have loopback-only networking and reach the proxy only through their own socket. That socket also identifies the cell, and so its agent and connectors.
- **The cell is the boundary for Codex.** Codex runs in `danger-full-access` inside an unprivileged, user-namespaced, capability-free nspawn cell with a volatile root and a persistent per-agent home. The per-agent `codex-workspace-write` opt-in loads an AppArmor profile that lets `bwrap` create user namespaces VM-wide.
- **The daemon treats the cell runner as untrusted.** Frames are size-limited and schema-checked, and events must belong to the running turn; the first violation ends the cell. Clients strip escape sequences and control characters from all agent text. Builder proposals are written only after a full-screen confirmation.
- **Claude Code** is handled like Codex: the cell holds a placeholder (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), the proxy replaces it on `api.anthropic.com` only, and OAuth token exchange and organization administration are denied. Claude Code runs with permission checks bypassed and no settings files loaded; the cell is the boundary.
- **Anchi tools come from the cell and are checked by the daemon.** The in-cell MCP server and the runner are untrusted relays. The daemon knows each cell's task and agent from its runner channel and allows a call only if that agent may make it (`delegates`, its own child tasks).
- **Gmail, Drive, Notion and Slack:** a cell sees no service socket. It gets bridge sockets for its agent's own service connectors only; the bridge in `anchi-egress` forwards each request with the cell's agent, overriding anything the cell sent, and the services accept a named agent only from the bridge's UID. Policy grants are per agent (`notion:<agent>`); an agent's `ask` holds its writes, the service-wide mode applies to every agent, and the daily write limit stays per service.
- **Held writes.** With `approvals: {<connector>: ask}` the proxy holds an agent's writes before fetching the credential, and sends nothing upstream unless the user approves in a full-screen dialog; it refuses after five minutes. Reads are never held. The dialog shows the git refs or the start of the body, which is agent-originated text; the audit log records the outcome, not the body. A held write proves the user saw that request, not that the agent's other traffic is harmless.
- **High-risk operations are held for every agent and origin** (merges, repository deletion and settings, branch protection and access, pushes to `main`/`master`, ref deletion, AWS deletion and access changes, Linear deletion), with the task's origin chain in the dialog. The list is a fixed set of patterns: an equivalent operation through another endpoint, or a force-push to another branch, is not covered.
- **Delegation and triggers widen what untrusted input can reach.** A polled issue or a delegated task text becomes another agent's task input. `delegates` allowlists and `approvals` on writes are the controls; delegation depth and turn limits only stop loops. Polls run fixed read-only queries in the egress service with the vault credential; no cell is involved.
- **Workspaces** (macOS): `~/AnchiWorkspaces` is mounted in the VM, and a cell gets only its agent's directories under it, read-only unless `rw`. Paths are checked in the daemon and again in the cell manager (no `..`, no symlinks on the way). An `rw` workspace lets the agent write files that run on the Mac later; Anchi masks git hooks, config and info and common editor and shell configuration read-only, and audits each turn for new hooks, command-running git configuration, outside symlinks, new executables and editor configuration. Files run by design (`package.json`, `Makefile`) remain the user's to review. What an agent reads in a workspace can leave through the proxy like anything else it reads. Deleting an agent never removes workspace files: the binds exist only in the cell's mount namespace, and the VM removes an agent's home only when it has no cell and no mount point below it, without crossing file systems.
- **Every cell is scanned before it is destroyed** (idle timeout, cancellation, replacement, daemon shutdown): its processes, environment and files are compared with the vault's real values, and a finding is recorded in the task and raises a notification. Only labels are reported, never values.
- **Large requests.** A request body over 8 MiB streams through the proxy and its headers leave before the body is read, so only S3 calls are injected on that path (their operation comes from method and path); any other streamed request leaves without credentials and is audited as `pass:streamed`.
- **Skills are untrusted content**, copied read-only into the cells of the agents that list them. A skill from GitHub is pinned to the commit it was fetched at; updating it installs only the commit whose changes the user reviewed.
- **Audit.** `/var/log/anchi-egress/audit.jsonl` records method, host, path, operation, decision, task and agent, and whether the cell sent a placeholder, nothing or a credential of its own, never header values or query strings. The user sees a task's rows with `anchi audit TASK` or **a** on the task; the daemon reads them through a fixed guest command that takes only a task id. They are written by the trusted proxy, but hosts and paths come from the agent's requests and are rendered as agent text. The file rotates at 50 MB and keeps one older file; the daemon saves each task's rows when its cells close, so a task's record lasts as long as the task. When a cell sends a credential that is not a placeholder, the proxy alerts the daemon at once (a note in the task and a desktop notification); this flags a credential that reached the cell from elsewhere, and does not stop the request. `make verify-anchi` runs the live isolation checks, and `anchi scan TASK` checks a live cell for real credential values.
- **Subscription limits.** The proxy reads the limits of the Codex and Claude subscriptions from responses it injected credentials into: Codex's rate-limit message in the model stream (plan, percent used, window length and reset time, all bounded) and Claude's `anthropic-ratelimit-*` headers (printable, bounded). It parses only that message type and keeps nothing else of the stream. The values live in the proxy's memory and are not a security control.

## Isolation and platform limits

Linux and macOS share the same trust boundaries: services and cells run inside a Lima VM. Linux uses QEMU/KVM and QEMU user-mode NAT; the host administrator grants `/dev/kvm` access. The user installs Lima (Homebrew on macOS); the Linux CI pins Lima by SHA-256. Inside the VM, Node, Codex and Claude Code are pinned by version and SHA-256 in `guest/cell.env`, not by publisher signatures.

The daemon's task store (`~/.anchi/data/anchi.db`, mode 0600 directory) keeps task transcripts, including agent-originated text and tool output, on the host. Finished tasks are deleted after `retentionDays` (default 90), and `anchi rm` deletes a task at once. Full policy audit remains in the VM policy database and the egress audit log; both are read through trusted administration. Cell and service JSON uses UTF-8 byte limits.

Installing (`setup install`) and `make verify-anchi` restart or reap cells, so both refuse while task cells are live in the VM, unless explicitly forced.

Host and VM administrators can access trusted components. nspawn shares the guest kernel. Passing isolation tests does not prove escape is impossible. Allowed model/connector channels do not prevent every form of content exfiltration.

## Reporting a vulnerability

Use an existing private contact channel with the maintainer. The repository has no dedicated public security email or bug bounty program. Do not post real tokens, mail, credential-file contents or directly usable private attack material in public issues.

Include the affected version, environment, minimal synthetic reproduction, expected boundary and observed behavior. Fixes involving approval, credential reads, process escape or egress bypass require regression coverage. See the [security foundation](docs/SECURITY_FOUNDATION.md) for deployment details.
