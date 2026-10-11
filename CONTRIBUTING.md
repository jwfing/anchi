# Contributing to Anchi

Anchi is a secured agent team in development: not audited and not ready for public distribution. Changes to a boundary (credentials, cells, egress, approvals, policy) need tests that would fail if the boundary broke. Read the [repository architecture](docs/architecture/REPOSITORY.md) and [security boundaries](SECURITY.md) before making changes.

## Contributions and pull requests

Contribute fixes, onboarding improvements, security-boundary tests, documentation or reproducible bug reports. Open an issue to agree on the scope of substantial features or architecture changes.

Bug reports should include OS and Anchi versions, reproduction steps, expected behavior and actual results. Prefer synthetic data. Report vulnerabilities privately under [SECURITY.md](SECURITY.md); never publish credentials or private material in an issue.

Fork and clone the repository, then create a focused branch:

```bash
git switch -c fix/describe-the-change
```

Push the branch to your fork and open a PR describing the concrete problem, resulting behavior, related issue, checks performed, untested scenarios and limitations. TUI changes can include sanitized screenshots. Installation, permission and isolation changes should identify the live environment and results. Keep each PR focused and address review feedback.

## Development environment

macOS on Apple Silicon is the primary target; Linux x86_64 support is experimental. Offline checks run on Linux and macOS. Install Node 22+, pnpm, Python 3.11+ and, for live checks, Lima; CI uses `.nvmrc` and Python 3.13.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
pnpm --dir anchi install
make check PYTHON=.venv/bin/python
```

`anchi/pnpm-lock.yaml` pins the workspace. Dependency updates include manifest and lockfile, and respect pnpm's minimum release age: pin an older version instead of excluding a package from that policy.

## Coding agents

Coding agents (Codex, Claude Code and others) read [AGENTS.md](AGENTS.md) and the project skills in `.agents/skills/` (Claude Code through `CLAUDE.md` and the `.claude/skills` link). Keep them in step with this guide when a rule changes.

## Daily workflow

- Run `make check` before submitting: Ruff, shellcheck when installed, Prettier, the trust-zone dependency check, syntax checks and all offline tests. It does not operate the VM, access accounts or call models. Some tests open loopback listeners.
- `make format` uses Ruff for Python and Prettier for `anchi/`; see `ruff.toml` and `anchi/.prettierrc.json`. Avoid unrelated repository-wide formatting in security changes.
- Keep cell UIDs and the Node, Codex, Claude Code and base-image toolchain (pnpm, Go, Rust) pins in `guest/cell.env`; do not duplicate these literals elsewhere.
- Host packages (`protocol`, `core`, `daemon`, `tui`) must not import a runtime SDK or the cell runner; the cell runner must not import host packages. `anchi/scripts/check-deps.mjs` enforces it.
- Everything a cell sends is untrusted. New runner frames, tools or guest commands need schema validation, bounds and tests of the refusal paths. Secrets go to the VM on stdin only.
- Live checks are explicit: `make verify-vm`, `make verify-anchi` (no credentials) and `scripts/anchi-acceptance.sh` (real accounts).
- New agent configuration fields need a schema, validation and documentation in the [contracts](docs/architecture/AGENT_TEAM_CONTRACTS.md).
- Update capability documentation when behavior changes. Distinguish prototypes, implemented features and future plans.

## Documentation

Write documentation in English. `README.md` is the single project overview; do not maintain language-specific duplicates. Link task-specific guides from [docs/README.md](docs/README.md). Keep current guides directly under `docs/`, architecture under `docs/architecture/`, and release procedures under `docs/engineering/`. Keep maintained documentation aligned with the current implementation. Remove superseded proposals and dated acceptance reports; use Git history for historical context. Document verification commands and current limitations rather than old test totals.

Keep commands, paths, protocol fields and configuration keys exact. UI labels in the app may remain localized; English documentation describes the corresponding control. Update relative links and heading anchors whenever a document moves or a heading changes.

## Test layers

| Layer | Location | Dependencies and purpose |
|---|---|---|
| Service boundaries | `tests/` | Python + cryptography + botocore; mocked networking and policy |
| Agent team | `anchi/packages/*/test/` | Node; schemas, runner protocol, daemon with a fake guest, TUI rendering and keys |
| Live isolation | `guest/check-*.py`, `scripts/verify.sh`, `guest/check-anchi.py` | Deployed VM; OS, service and cell boundaries; no credentials |
| Live acceptance | `scripts/anchi-acceptance.sh` | Real accounts; scenarios with credential scans |

## Releases

Follow the [release guide](docs/engineering/RELEASE.md). Never commit `artifacts/`, `node_modules`, credentials, mail bodies or real user sessions. Contributions are licensed under [Apache-2.0](license.md); ensure you have the right to contribute and retain third-party notices.
