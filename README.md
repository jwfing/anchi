# Anchi / 安栖

> **Anchi — a secured agent team.** Pronounced *AHN-chee*. 安栖 (ān qī) means a safe place to settle and rest: a home where a team can work without being exposed.

Anchi runs a team of Codex and Claude Code agents on your own machine and gives each agent only what its job needs. A misled or compromised agent can still misuse what it was given and leak what it reads, but it never holds a credential, it reaches only the services and directories it was configured with, and with an `egress` list only those hosts:

- **Upstream credentials never enter an agent's sandbox.** Each task runs in a disposable cell inside a Linux VM. A trusted egress proxy injects or re-signs GitHub, AWS, Linear and model credentials on the way out; trusted services in the VM act for agents on Gmail, Drive, Notion and Slack.
- **Each agent gets only what it is configured with:** its connectors, the hosts it may reach (any public host unless you list them), the directories of your Mac it may see, its skills and the agents it may delegate to.
- **You decide on writes.** High-risk operations of every agent (merges, deletions, pushes to `main`, access changes) always wait for your approval, as do all writes of agents whose `approvals` say `ask`; the dialog shows how the task started.
- **Checks run by themselves.** Every cell is scanned for real credential values before it is destroyed, and `make verify-anchi` checks the isolation live.

You drive the team from a terminal UI or a CLI (`anchi`): build agents by describing them, give them tasks, let them delegate to each other, start them on a schedule or for new issues. Start with the [getting started guide](docs/GETTING_STARTED.md), then the [agent team guide](docs/AGENT_TEAM.md).

This is a **development build**: it has not had a security audit and the packaged distribution is a development preview.

Install the packaged app:

```bash
curl -fsSL https://anchi.elseward.xyz/install.sh | sh
anchi
```

The app includes Node and its dependencies. The Runtimes screen guides VM setup;
macOS needs Lima and Python (`brew install lima python`). See the getting started guide
for Linux prerequisites and the source development workflow.

## Current capabilities

| Capability | Status |
|---|---|
| Lima VM with trusted services; each task in a disposable systemd-nspawn cell with loopback-only networking | Implemented; `make verify-vm` and `make verify-anchi` run the live isolation checks |
| Codex and Claude Code in cells, holding placeholders only | Implemented; the proxy substitutes subscription tokens replace-only; the Codex login is re-imported from your machine as it refreshes |
| GitHub, AWS (re-signing, SSO profiles, `aws-chunked` uploads) and Linear through the egress proxy | Implemented; credential minting denied; credentials verified at import |
| Gmail, Drive, Notion and Slack through trusted services, reached through a per-cell bridge that names the agent | Implemented; Gmail is read-only; per-service and per-agent write approval |
| Per-agent egress allowlists, high-risk operations always held, held writes with the task's origin chain | Implemented |
| Credential scan of every cell before it is destroyed | Implemented; a finding raises a notification |
| Directories of your computer in agent cells (`~/AnchiWorkspaces`), read-only or writable, with code-running paths masked and audited | Implemented on macOS and Linux |
| Delegation, schedule and polling triggers, skills (local or pinned GitHub commits, updatable) | Implemented |
| Agent builder that knows what exists, agent settings panel, deleting agents with their tasks and VM files | Implemented |
| Task history with search, delegation trees, retry of failed tasks; TUI with leader-key bindings and a command palette | Implemented |
| Live acceptance with real accounts | Partly done; see the [phase 3 status](docs/architecture/AGENT_TEAM_PHASE3_PLAN.md#status) |
| Remote machines, public distribution, signed packages | Not planned or not complete |

Content an agent reads may reach a cloud model or any public host it is allowed to reach. Credential isolation does **not** mean data isolation. See the [security model](SECURITY.md) for the boundaries and their limits.

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
| `landing/` | The static landing page |
| `docs/` | Guides, architecture and engineering notes |

See [module responsibilities](docs/architecture/REPOSITORY.md).

## Contributing

Bug reports, documentation, tests and code contributions are welcome. Discuss substantial feature or architecture changes in an issue first. Report security problems privately as described in [SECURITY.md](SECURITY.md).

Follow [CONTRIBUTING.md](CONTRIBUTING.md) to prepare a branch and run checks. Each PR should explain the problem, resulting behavior, validation and known limitations, with live evidence for installation or isolation changes. Do not commit credentials, real messages or sessions, dependencies, or build artifacts.

All maintained documentation is written in English. See the [documentation index](docs/README.md) and [changelog](CHANGELOG.md).

## License

[Apache License 2.0](license.md). Copyright 2026 Junwen. Third-party dependencies and bundled files retain their own copyright and license notices.
