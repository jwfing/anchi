# Repository architecture and responsibilities

The monorepo follows trust boundaries. Deployed script and guest paths stay stable rather than changing solely for naming consistency. This map describes the current modules and their dependencies.

## Modules

| Location | Responsibility |
|---|---|
| `desktop/src/main/app.cjs` | Electron windows and lifecycle assembly |
| `desktop/src/main/security.cjs` | Asset allowlist, browser permissions and IPC-origin validation |
| `desktop/src/main/controller.cjs` | Use cases, approval handling and operation allowlist |
| `desktop/src/main/runtime.cjs` | Fixed Lima and administration script invocations |
| `desktop/src/main/pi-client.cjs` | Pi connection, request correlation, timeout and disconnect |
| `desktop/src/main/directory-store.cjs` | Versioned directory plans; v2 includes identity; transactional persistence |
| `desktop/src/main/file-broker.cjs` | In-process directory capabilities, restore and serialized revocation |
| `desktop/src/main/activity-log.cjs` | Durable activity metadata only |
| `desktop/src/main/platform.cjs` | Platform-specific tool paths, protected directories, dependency policy, child PATH and KVM |
| `desktop/src/main/host-tools.cjs` | Resolve executables using platform tables |
| `desktop/src/main/downloader.cjs`, `desktop/host-tools.json` | Pinned Linux tool downloads and SHA-256 verification |
| `desktop/src/main/user-data.cjs` | One-time configuration migration |
| `desktop/src/main/token-window.cjs` | Separate static-token input modal |
| `desktop/src/main/oauth.cjs` | Loopback callback and browser authentication |
| `desktop/src/main/setup.cjs` | Setup state, bounded install/login commands and interrupted-job recovery |
| `desktop/src/shared/` | Protocol, validation, transport limits and connector UI descriptors |
| `desktop/src/preload.cjs` | Minimal contextBridge |
| `desktop/src/renderer/` | ES-module presentation; pure views/activity formatting; no OS or token access; token page is separate from agent content |
| `desktop/scripts/` | Source checks, allowlisted runtime bundle, host-specific packaging, releases and live file checks |
| `desktop/tests/` | Business/boundary tests without importing Electron into domain code |
| `pi/` | Untrusted-cell Pi adapter and RPC; `version.mjs`/`limits.mjs` provide version/limits |
| `services/connectors.py` | Connector registry |
| `services/ledger.py`, `connector_base.py` | Shared execution ledger and connector read/write flow |
| `services/drive.py`, `notion.py`, `slack.py`, `gmail.py` | Provider handlers |
| `services/connector_admin.py` | Account probes and disconnect |
| Other `services/` modules | Trusted auth, policy, inference and readiness metadata |
| `guest/` | Cell construction, startup and live checks; `cell.env` owns UID/version pins, `arch.sh` maps architecture/driver |
| `systemd/`, `lima/` | Service identities, sockets, resource limits and outer VM |
| `scripts/` | Stable host CLI and explicit deployment/live checks |
| `tests/` | Trusted-service offline regression tests |
| `prototype/` | Simulated UX reference, excluded from product packaging |
| `docs/` | Current usage, architecture, security and release guides |
| `artifacts/` | Local build output, not version-controlled |

## Call direction

Renderer → preload → main-process Controller → PiClient → fixed host script → cell Pi.

Controller → Runtime → independent policy administration. Approval details come from policy, never agent messages; a Pi approval event is only a notification.

Cell Pi → Unix socket → connector/inference → auth + policy → upstream. Never expose auth sockets or administration to the cell for UI convenience.

`file-broker.cjs` owns host capabilities while `scripts/host-files.py` enforces access with directory file descriptors. `pi/host-files.mjs` forwards requests but cannot grant itself access. OAuth sends authorization through `runtime.auth` and guest stdin; the renderer never sees codes, PKCE verifiers or tokens.

## Design decisions

1. Domain logic does not import Electron. Dialog/process/filesystem boundaries accept test doubles.
2. Both host IPC and Pi RPC are allowlisted; neither becomes generic exec.
3. Directory schema v2 reads v1/unversioned plans. Native confirmation records device/inode. Restore only identical directories; preserve corrupt/future-version originals.
4. Write configuration to a temporary file, fsync, atomically rename, then update memory. Serialize mutations.
5. Packaged scripts come from `Resources/runtime`, never developer absolute paths. Setup can provision dependencies, but actual runtime still needs Lima and a configured VM.
6. Disconnect closes stdin for remote EOF cleanup; timeout escalates TERM to KILL. In-flight upstream calls may continue.
7. Default checks are offline. VM, account and model checks are explicit.
8. `guest/cell.env` owns UID/Node/Pi pins; tests align the three language-specific transport limits. Main injects the app version into the page.
9. Desktop persists event metadata only. VM audit is read through policy administration.
10. Platform differences belong in `platform.cjs` and `guest/arch.sh`. One Lima template lists both architectures; `up.sh` selects the driver. Host downloads use manifest SHA-256 pins.
11. Registry entries drive or consistency-check service modes, egress, credential scope, policy, installation and Pi tools. Writes reuse one-time policy grants and connector ledgers.

Setup readiness exposes metadata only. First-task success requires matching session and turn plus a reply and completion. Model authorization follows the configured policy mode.

## Future work

Task-scoped authorization, context compaction, a persistent guest management channel, audit export, completed signing/notarization acceptance, automatic updates and multiple agents. Extend existing boundaries rather than mapping prototype buttons directly to privileged host operations. The installed guest version manifest can support later upgrade negotiation.
