# Anchi / 安栖

A self-contained permission runtime for local agents: accounts are held by the environment, and the agent uses resources only through controlled interfaces. This is an **MVP development build**. The isolation proof of concept and the desktop control plane are implemented; it is not yet ready for public distribution.

The primary documentation is in Chinese ([README.md](README.md)). This page summarizes the project for English-speaking contributors.

## What exists today

| Capability | Status |
|---|---|
| Lima/VZ VM, nspawn cell and per-service identities | Implemented and verified with live isolation checks |
| Independent auth, policy, Gmail and inference services | Implemented; Gmail is read-only |
| Pi agent inside the cell, Codex subscription auth, JSONL RPC | Implemented; credentials never enter the cell |
| Desktop chat, session resume, cancel, independent approval | Implemented |
| Host directory grants with read-only / read-write modes | Implemented; grants persist and are restored only for the identical directory |
| Recoverable file deletes and overwrites (hidden trash inside the granted directory) | Implemented |
| Desktop Gmail OAuth, disconnect, standing read consent, re-authentication state | Implemented |
| First-run setup, dependency install, VM/Pi install, vault unlock, model login | Implemented |
| Activity log on disk (metadata only) and VM policy audit read-out | Implemented |
| Task-scoped grants, multiple agents, Gmail send | Not implemented |
| Developer ID signing, notarization, auto-update | Pipeline exists; no certificate yet |

Content the agent reads can be sent to the cloud model. Credential isolation does not mean data stays on the machine. See [SECURITY.md](SECURITY.md).

## Layout

| Directory | Role |
|---|---|
| `desktop/` | Electron main process (trusted control plane), renderer, tests |
| `pi/` | Pi adapter running inside the untrusted cell |
| `services/` | Trusted auth, policy, Gmail and model gateway services (Python, no third-party deps) |
| `guest/`, `systemd/`, `lima/` | Cell build, service units and VM definition; `guest/cell.env` is the single source for UID mapping and pinned versions |
| `scripts/` | Host CLI entry points and explicit live verification |
| `tests/` | Offline regression tests for the trusted services |

## Development

Requires Node 22+, Python 3.11+, macOS on Apple Silicon for the desktop and VM.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci --prefix desktop
npm ci --prefix pi
make check PYTHON=.venv/bin/python   # lint, formatting and all offline tests
make format PYTHON=.venv/bin/python  # ruff + prettier
make desktop                          # run the desktop app from source
```

`make check` never touches the VM, Google or the model. Live checks are explicit: `make verify-vm`, `python3 scripts/check-pi-rpc.py`, `node desktop/scripts/verify-files.cjs`.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese). Licensed under Apache-2.0.
