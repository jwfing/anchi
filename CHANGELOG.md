# Changelog

Follows the Keep a Changelog structure. The version comes from `anchi/package.json`.

## 0.2.0 — Unreleased

The agent team replaces the desktop app and Pi. Run `scripts/anchi setup install` to update an existing VM; it disables the Pi inference gateway and removes Pi from the cell root filesystem. Credentials in the vault are kept.

### Added

- Daemon, TUI and CLI (`scripts/anchi`) for a team of Codex and Claude Code agents, each task in a disposable nspawn cell on layered images, with an agent builder.
- Egress proxy that keeps credentials out of cells: replace-only runtime tokens, GitHub, AWS (re-signing, SSO profiles) and Linear injection, credential-minting denials, destination filtering against SSRF and DNS rebinding, connector verification at import.
- Gmail, Drive, Notion and Slack for agents through a per-cell bridge that names the agent to the service, so `approvals` holds one agent's writes; Google sign-in, tokens and write modes set up from the daemon.
- Delegation between agents, approvals of held writes, schedule and polling triggers, skills, task search, trees, deletion and retention.
- S3 `aws-chunked` uploads, signed or unsigned, re-signed by the proxy, also when streamed. S3 multi-object deletes, expiry rules, bucket policies and ACLs always ask.
- Linux hosts (experimental): notifications through `notify-send`, Google sign-in through `xdg-open`, `daemon install` as a systemd user unit, `/dev/kvm` and QEMU checks before installing.
- Deleting agents (D, ^X D, `anchi agents rm`): the agent file, its tasks with what they delegated (cancelled first), trigger state, its place in other agents' `delegates`, and its home, skills and policy rules in the VM, after typing its id. Workspaces on the Mac are never touched.
- Agent settings panel (^X s): skills, connectors and workspaces of an agent, saved after a diff, keeping the rest of the file. The builder gets an inventory of what exists each turn; proposals and settings changes are checked against it, and a proposal's settings can be picked in its dialog (s). `anchi skills update` and **u** on the Skills screen update a GitHub skill to the commit you reviewed; skills can be given an id when added.
- TUI key bindings: every action through the leader key Ctrl+X with a panel of the keys that follow, plain keys in views without text input, a command palette (^X Space), shell line editing in the chat input, and `~/.anchi/keybindings.json` (`anchi keys`). Ctrl+X alone, Ctrl+A, Ctrl+E, Ctrl+T and Ctrl+O no longer act as before: new task is ^X n, approvals ^X a, the editor Ctrl+G or ^X e, tool calls ^X t, the builder proposal ^X o.
- Running a failed or cancelled task again (R, ^X r, `anchi retry`): continue its session with a note of why it stopped, or start over as a new task.
- A task's external access (a, ^X l, `anchi audit`): hosts reached and decisions, credentials injected by the proxy, what the cell sent as credential, refusals, held writes, bridge calls and the scan, read from the egress proxy's audit log.
- A task's audit rows are saved by the daemon when its cells close, so its access record outlives the log's rotation; a cell sending a credential that is not a placeholder is noted in the task and notified at once.
- Token usage per turn (input, cached, output, reasoning, model, Claude Code's cost estimate) with totals by agent, model, runtime or day (Configure → Usage, `anchi usage`), and the subscription limits the egress proxy last saw: Codex's plan and 5-hour and weekly windows, Claude Code's rate-limit headers.
- Live checks `make verify-anchi` and acceptance script `scripts/anchi-acceptance.sh`.

### Fixed

- Installing (`setup install`, `scripts/install-anchi.sh`) and `make verify-anchi` ended running tasks: installing restarts the egress proxy, and the live checks reaped every cell. Both now refuse while tasks run, and the checks only ever reap their own cells.
- The egress proxy hit its 1024 open-file limit under package installs with hundreds of connections (`Too many open files`); the limit is now 65536.
- Request bodies over 8 MiB were audited as injected although their headers had already left; they are now audited as `pass:streamed`.

### Removed

- The Electron desktop app (`desktop/`), Pi (`pi/`), the Pi inference gateway (`secure-inference`) and the host directory broker. Use the TUI or CLI.

## 0.1.x — desktop app (retired in 0.2.0)

### Added

- English desktop interface by default, with a persistent English/Simplified Chinese toggle beside the sidebar collapse control. Pages, token entry, native confirmations and activity labels follow the selected language while chat and approval content remain unchanged.

- Persistent directory grants: schema v2 records device and inode at authorization, restores only unchanged identities and explains inactive moved/replaced/inaccessible directories.
- Recoverable file deletion/overwrite through hidden `.anchi-trash` inside each grant; inaccessible to agents.
- Gmail reauthentication-required state after invalid refresh credentials, avoiding repeated Google requests.
- Metadata-only `activity.jsonl` and desktop access to VM audit through `policy_admin.py audit`.
- Automatic pending-approval loading, navigation count badge, structured action/account/model/tool/recent-input summaries and expandable full JSON.
- Setup authentication-expiry and VM-version display; guest `/opt/secure-vm/installed.json`.
- `guest/cell.env` as the single source for cell UID mapping and Node/Pi pins, shared by shell, Python, Pi and tests.
- Cross-language transport-limit consistency tests for Python, Pi and desktop.
- `make lint` with Ruff, shellcheck and Prettier, including Pi; shellcheck CI, unsigned packaging smoke jobs and Dependabot.
- Regression coverage for service UID/rate limits, bridge approval waits and UTF-8 framing, egress refresh, readiness, nested multipart mail, directory restore, activity logs and configuration migration.
- Experimental Linux x86_64 desktop: Lima/QEMU/KVM, one dual-architecture VM template with explicit driver selection, pinned SHA-256 Lima/Codex downloads, user-run QEMU/KVM privileged steps, platform/downloader/tool-manifest/guest-architecture modules, Linux tarball and fresh-VM KVM CI.
- Drive, Notion and Slack connectors alongside registry-based Gmail: separate identities/egress, revision-bound writes, per-connector execution ledgers and quotas, separate static-token input window, dynamic Pi tool registration, descriptor-based cards and write-approval banners. The initial per-write approval design was superseded by authorization modes below.

### Fixed

- Restore write ledgers only for write-capable connectors, avoiding Gmail startup failure on its read-only filesystem. Failed recovery retains reads but rejects writes.
- Reject writable grants over Anchi code, runtime resources, real tool directories and installation roots. Standalone `~/bin` tools no longer protect the entire home; stale tool paths no longer terminate startup.
- Connector approval waits retain request IDs and support real-timer cancellation. Frozen writes do not refetch target revisions on replay. Preparation avoids holding SQLite write locks, reserves quota early and removes frozen content older than seven days.
- Drive text updates require a revision precheck with optional ETag; Google Docs overwrite is refused. Ambiguous remote writes become UNKNOWN; read-only POST remains a read.
- Local overwrite backs up before atomic replacement, uses fixed-length trash IDs, avoids orphan sidecars on copy failure and continues after short reads.
- Notion nested-block reading distinguishes truncated text from omitted nontext content; Slack history respects total serialized UTF-8 size.
- Download-failure cleanup waits for file open/close to avoid temporary-file races on macOS CI.
- Accept Codex reasoning items containing `content: []`, which Pi replays into later turns. Previously schema rejection before authorization broke subsequent model calls after the first reasoning summary.

### Changed

- Per-subject authorization modes for Gmail, Drive, Notion, Slack and `inference`: `auto` is default standing authorization for reads, writes and model calls; `ask` requires per-request approval. Both issue/audit one-time grants. Added `policy.sh rules` and `mode <subject> auto|ask`, retaining `read`/`gmail-read` aliases. Desktop mode restoration confirms prompt-injection risk; setup controls model mode. Changes revoke all unconsumed grants.
- Expired model authentication can be reimported or renewed without disconnecting Pi; rebuilding the environment still requires disconnecting.
- Cell/service JSON uses UTF-8 byte accounting, approximately doubling Chinese-context capacity compared with the previous escaped encoding.
- File broker uses setup-installed host Python rather than a fixed system interpreter.
- Renderer coalesces event-driven snapshots and preserves input focus; navigation is no longer blocked by long-running actions.
- Qisuo-to-Anchi migration: one-time user-data rename, canonical `ANCHI_*` release variables with legacy aliases, `local.anchi.desktop` development Bundle ID and `anchi-desktop`/`anchi-pi` package names.
- Main process injects the app version instead of hard-coding it in HTML.
- Documentation consolidated into one English README and current English usage, architecture, security and release guides. Removed historical proposals, implementation plans, legacy runbooks and dated acceptance reports; their original versions remain in Git history.

### Known incomplete work

Task-scoped grants, multiple agents, Gmail sending, context compaction, the future of legacy API-key inference, completed signing/notarization acceptance and automatic updates. See the README capability table.
