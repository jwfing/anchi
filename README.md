# Anchi / 安栖

Anchi is a permission runtime for local agents. The environment holds account credentials; agents use resources through controlled interfaces. This is an **MVP development build**, not a publicly distributable release. The isolation proof of concept and desktop control plane are implemented.

Start with the [getting started guide](docs/GETTING_STARTED.md). You do not need to deploy a VM manually before using desktop setup. System installation prompts and browser sign-in require your participation.

## Current capabilities

| Capability | Status |
|---|---|
| Lima VM, systemd-nspawn cell, separate service identities | Implemented; live isolation checks completed |
| Independent auth, policy, Gmail and inference services | Implemented; Gmail remains read-only |
| Google Drive, Notion and Slack connectors | Implemented; standing authorization by default, optional per-request approval, revision-bound updates; real-account validation remains incomplete |
| Pi, Codex subscription authentication and multi-turn JSONL RPC | Implemented; credentials never enter the cell |
| Desktop chat, session recovery, cancellation and independent approval | Implemented against the real runtime |
| Native read-only/read-write directory grants | Implemented through a host file broker; grants persist until revoked and restore only when directory identity matches; synthetic round-trip verified in a real cell |
| Recoverable file deletion and overwrite | Old content moves to a hidden `.anchi-trash` inside the granted directory, inaccessible to the agent |
| Desktop Google OAuth, disconnect, authorization modes and reauthentication | Implemented; the account owner completes browser consent |
| First-run setup, dependencies, VM/Pi installation, vault unlock and model login | Implemented; fresh VM installation and retry verified; expired model authentication can be reimported without disconnecting Pi |
| First example task and approval guidance | Implemented; model calls use standing authorization by default, with optional per-turn approval |
| Approval summaries, pending badge, durable activity metadata and VM audit access | Implemented; desktop activity does not persist chat or approval bodies |
| Task-scoped grants, multiple agent instances and automatic context compaction | Not implemented |
| Gmail sending | Deferred; remains a design proposal |
| API-key inference (`inference.openai`) | Used only by the legacy restricted workflow in `guest/agent.py`; integration with Pi or removal remains undecided |
| Developer ID signing and notarization | Release pipeline implemented; no formal signed artifact has been validated without the required certificate |
| Automatic updates and public distribution | Not complete |

Content an agent reads may enter a cloud model. Credential isolation does **not** mean data stays on the machine. See the [security model](SECURITY.md) for authorization defaults, limits and remaining risks.

## Supported hosts

| Host | Status | Isolation layer |
|---|---|---|
| macOS on Apple Silicon | Supported | Lima + Virtualization.framework |
| Linux x86_64 (Ubuntu 22.04+ / Debian 12+) | Experimental; KVM CI coverage uses Ubuntu 24.04 | Lima + QEMU/KVM |
| Other platforms | Unsupported | — |

On Linux, setup downloads pinned Lima and Codex CLI builds with SHA-256 verification into `~/.local/share/anchi/tools`. QEMU installation and any required KVM group changes are commands you run in a terminal; the app does not request an administrator password. See [Linux setup](docs/GETTING_STARTED.md#linux).

## Development

Requires Node 22+, npm and Python 3.11+.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci --prefix desktop
npm ci --prefix pi
make check PYTHON=.venv/bin/python
make desktop
```

`make check` runs Ruff, shellcheck when installed, Prettier, syntax checks and offline tests. It does not access a VM, Google account or model. Some OAuth tests open a local loopback listener.

```bash
make help        # List entry points
make lint        # Ruff, shellcheck and Prettier checks
make format      # Format Python, desktop and Pi sources
make verify-vm   # Explicit live VM isolation checks
```

Desktop setup can install or connect to `secure-vm`. For command-line deployment, see [Pi installation and authentication](docs/PI_AGENT.md); `bash scripts/up.sh` remains the base VM entry point. Deployment changes the host or VM and is separate from default checks.

Package locally with `make package PYTHON=.venv/bin/python`. Version 0.1.1 produces `artifacts/releases/0.1.1/Anchi-darwin-arm64/Anchi.app` on macOS, or a Linux archive on Linux. Packaged apps include their runtime scripts and do not depend on a developer checkout. Lima and a configured VM are still required at runtime. See [desktop usage](docs/DESKTOP_APP.md) and [release engineering](docs/engineering/RELEASE.md).

## Repository layout

| Directory | Responsibility |
|---|---|
| `desktop/` | Electron UI, trusted host control plane, configuration and Pi process management |
| `pi/` | Pi adapter and RPC inside the untrusted cell |
| `services/` | Trusted authentication, policy, connectors and model gateway |
| `guest/`, `systemd/`, `lima/` | Isolation environment, deployment and service configuration |
| `scripts/` | Stable host CLI entry points and explicit live checks |
| `tests/` | Offline service regression tests |
| `prototype/` | Simulated UX reference; excluded from app packaging |
| `landing/` | Static product landing page for `anchi.elseward.xyz`; see [preview and deployment notes](landing/README.md) |
| `docs/` | Current user guides, architecture and release procedures |

See [module responsibilities](docs/architecture/REPOSITORY.md). Existing guest and script paths remain stable to avoid breaking deployed environments.

## Contributing

Bug reports, documentation, tests and code contributions are welcome. Discuss substantial feature or architecture changes in an issue first. Report security problems privately as described in [SECURITY.md](SECURITY.md).

Follow [CONTRIBUTING.md](CONTRIBUTING.md) to prepare a branch and run checks. Each PR should explain the problem, resulting behavior, validation and known limitations. Include sanitized screenshots for UI changes and live evidence for installation or isolation changes. Do not commit credentials, real messages or sessions, dependencies, or build artifacts.

All maintained documentation is written in English. See the [documentation index](docs/README.md) and [changelog](CHANGELOG.md).

## License

[Apache License 2.0](license.md). Copyright 2026 Junwen. Third-party dependencies and bundled files retain their own copyright and license notices.
