# Repository architecture and responsibilities

The monorepo follows trust boundaries. Deployed script and guest paths stay stable rather than changing solely for naming consistency. This map describes the current modules and their dependencies.

## Modules

| Location | Responsibility |
|---|---|
| `anchi/packages/protocol` | Client, cell runner and event schemas; bounded JSON-lines codec |
| `anchi/packages/core` | Agent, image and trigger configuration (trusted, host) |
| `anchi/packages/daemon` | Daemon: task store, hub and queues, cell sessions, Anchi tool dispatcher, delegation, approvals, triggers, skills, setup steps, fixed guest commands (trusted, host) |
| `anchi/packages/tui` | Ink TUI and CLI; sanitizes all agent text (trusted, host) |
| `anchi/packages/cell-runner` | Inside task cells (untrusted): runner hosting the Codex and Claude Agent SDKs, the in-cell MCP server and its connector tools, the proxy forwarder |
| `guest/anchi_cell.py` | `anchi-cell` / `anchi-image`: task cells, image layers, reaper, approvals stream, polls, skills, live exec and credential scan (guest root) |
| `services/egress_rules.py`, `egress_proxy.py` | Egress proxy: injection, deny, write and poll rules independent of mitmproxy, and the mitmproxy addon with per-cell sockets, the approval queue and connector verification |
| `services/connectors.py` | Connector service registry |
| `services/ledger.py`, `connector_base.py` | Shared execution ledger and connector read/write flow |
| `services/drive.py`, `notion.py`, `slack.py`, `gmail.py` | Provider handlers |
| `services/connector_admin.py` | Account probes and disconnect |
| `services/auth.py`, `vault.py`, `policy.py`, `server.py` and `*_admin.py` | Vault, credential service, policy service and their administration |
| `guest/` | VM bring-up (`bootstrap.sh`), service and agent-team installers, live checks; `cell.env` owns UID and version pins, `arch.sh` maps architecture |
| `systemd/`, `lima/` | Service identities, sockets, resource limits and the outer VM |
| `scripts/` | Host entry points (`anchi`, `up.sh`, `install-anchi.sh`, `vault.py`) and explicit live checks |
| `tests/` | Offline tests of the trusted services |
| `poc/` | Phase 0 spikes and their recorded results |
| `prototype/`, `landing/` | UX reference and landing page, not part of the product |
| `docs/` | Usage, architecture, security and engineering guides |

## Call direction

TUI or CLI → daemon socket (0600) → daemon → fixed `anchi-cell`/`anchi-image` and administration commands over `limactl shell … sudo` → task cell runner (its stdio).

Cell runtime → in-cell MCP server → runner → daemon, for Anchi tools (delegation, task status). The daemon decides from the task and agent it attached to the cell.

Cell → its proxy socket → `anchi-egress` → `secure-auth` (credentials) → upstream. Cell → its bridge sockets → `anchi-egress` (names the agent) → connector service → auth + policy (per agent) → upstream. Never expose service sockets, auth sockets, policy administration or other agents' sockets to a cell.

Daemon → `anchi-cell approvals watch` ← proxy approval queue; decisions return through `anchi-cell approvals decide` or `policy_admin.py`. Google sign-in: daemon loopback callback → code over stdin → VM exchanges and stores the tokens.

A dependency check (`anchi/scripts/check-deps.mjs`) keeps runtime SDKs and the cell runner out of host packages, and host packages out of the cell runner.

## Design decisions

1. The cell runner, the MCP server, skills and everything the runtimes produce are untrusted. Frames are bounded and schema-checked; the first violation ends the cell.
2. Secrets travel to the VM on stdin only, never in arguments or logs, and never return to the Mac.
3. Default checks are offline. VM, account and model checks are explicit (`make verify-vm`, `make verify-anchi`, `scripts/anchi-acceptance.sh`).
4. `guest/cell.env` owns UID, Node, Codex and Claude Code pins; the cell runner's SDKs are pinned in `anchi/pnpm-lock.yaml`, never excluded from pnpm's release-age policy.
5. Registry entries drive or consistency-check service modes, egress, credential scope, policy and installation. Connector writes reuse one-time policy grants and ledgers.
6. Configuration and state files are written to a temporary file, then renamed; SQLite holds tasks, events and trigger state.

## Future work

Remote machines are not planned. Candidates: a GUI client on the same protocol, signed releases.
