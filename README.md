# Anchi / 安栖

Anchi runs a team of Codex and Claude Code agents on your Mac. Each task runs in a disposable cell inside a Linux VM, and upstream credentials stay outside the cells: a trusted egress proxy and trusted connector services use them on the agents' behalf. This is an **MVP development build**, not a publicly distributable release.

You drive the team from a terminal UI or a CLI (`scripts/anchi`). Start with the [getting started guide](docs/GETTING_STARTED.md), then the [agent team guide](docs/AGENT_TEAM.md).

## Current capabilities

| Capability | Status |
|---|---|
| Lima VM with long-running trusted services and per-task systemd-nspawn cells | Implemented; `make verify-vm` and `make verify-anchi` run the live isolation checks |
| Codex and Claude Code runtimes in cells, holding placeholders only | Implemented; the egress proxy substitutes subscription tokens replace-only |
| GitHub, AWS (re-signing, SSO profiles) and Linear through the egress proxy | Implemented; credential minting denied; credentials verified at import |
| Gmail, Drive, Notion and Slack through trusted services bound per agent | Implemented; Gmail is read-only; writes follow each service's policy (`auto` or `ask`) |
| Delegation between agents, schedule and polling triggers, skills | Implemented |
| Approval of writes in a full-screen dialog (`approvals: {github: ask}`) | Implemented for git push, API writes, AWS writes and GraphQL mutations |
| Agent builder, task history with search and delegation trees | Implemented |
| Live acceptance with real accounts | Partly done; see the [phase 1](docs/architecture/AGENT_TEAM_PHASE1_PLAN.md#status) and [phase 2](docs/architecture/AGENT_TEAM_PHASE2_PLAN.md#status) status |
| Remote machines, public distribution, signed packages | Not planned or not complete |

Content an agent reads may reach a cloud model or any public host. Credential isolation does **not** mean data isolation. See the [security model](SECURITY.md) for the boundaries and their limits.

## Supported hosts

| Host | Status | Isolation layer |
|---|---|---|
| macOS on Apple Silicon | Supported | Lima + Virtualization.framework |
| Linux x86_64 (Ubuntu 22.04+ / Debian 12+) | Experimental; KVM CI coverage uses Ubuntu 24.04 | Lima + QEMU/KVM |
| Other platforms | Unsupported | — |

## Development

Requires Node 22+, pnpm, Python 3.11+ and Lima.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
pnpm --dir anchi install
make check PYTHON=.venv/bin/python
```

`make check` runs Ruff, shellcheck when installed, Prettier, the trust-zone dependency check, syntax checks and the offline tests. It does not access a VM, an account or a model. Some tests open local loopback listeners.

```bash
make help          # List entry points
make lint          # Ruff, shellcheck and Prettier checks
make format        # Format Python and anchi sources
make verify-vm     # Live VM and service isolation checks
make verify-anchi  # Live agent-team cell and egress proxy checks
```

`scripts/anchi setup install` creates or updates the VM and installs everything; deployment changes the host and the VM and is separate from the default checks.

## Repository layout

| Directory | Responsibility |
|---|---|
| `anchi/` | Daemon, TUI and CLI (trusted, on the host) and the cell runner (untrusted, in cells); a pnpm workspace split by trust zone |
| `services/` | Trusted VM services: vault and auth, policy, connectors, the egress proxy |
| `guest/`, `systemd/`, `lima/` | VM bring-up, the task-cell manager, service units and VM configuration |
| `scripts/` | Host entry points (`anchi`, `up.sh`, `install-anchi.sh`, `vault.py`) and live checks |
| `tests/` | Offline tests of the Python services |
| `poc/` | Phase 0 spikes and their results |
| `prototype/`, `landing/` | UX reference and the static landing page |
| `docs/` | Guides, architecture and engineering notes |

See [module responsibilities](docs/architecture/REPOSITORY.md).

## Contributing

Bug reports, documentation, tests and code contributions are welcome. Discuss substantial feature or architecture changes in an issue first. Report security problems privately as described in [SECURITY.md](SECURITY.md).

Follow [CONTRIBUTING.md](CONTRIBUTING.md) to prepare a branch and run checks. Each PR should explain the problem, resulting behavior, validation and known limitations, with live evidence for installation or isolation changes. Do not commit credentials, real messages or sessions, dependencies, or build artifacts.

All maintained documentation is written in English. See the [documentation index](docs/README.md) and [changelog](CHANGELOG.md).

## License

[Apache License 2.0](license.md). Copyright 2026 Junwen. Third-party dependencies and bundled files retain their own copyright and license notices.
