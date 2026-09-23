# Changelog

Follows the Keep a Changelog structure. The app version comes from `desktop/package.json`.

## Unreleased

### Added

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
