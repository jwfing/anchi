# Contributing to Anchi

Anchi is an MVP development build, not ready for public distribution. Read the [repository architecture](docs/architecture/REPOSITORY.md) and [security boundaries](SECURITY.md) before making changes.

## Contributions and pull requests

Contribute fixes, onboarding improvements, security-boundary tests, documentation or reproducible bug reports. Open an issue to agree on the scope of substantial features or architecture changes.

Bug reports should include OS and app versions, reproduction steps, expected behavior and actual results. Prefer synthetic data. Report vulnerabilities privately under [SECURITY.md](SECURITY.md); never publish credentials or private material in an issue.

Fork and clone the repository, then create a focused branch:

```bash
git switch -c fix/describe-the-change
```

Push the branch to your fork and open a PR describing the concrete problem, resulting behavior, related issue, checks performed, untested scenarios and limitations. UI changes can include sanitized screenshots. Installation, permission and isolation changes should identify the live environment and results. Keep each PR focused and address review feedback.

## Development environment

macOS on Apple Silicon is the primary desktop/VM target; Linux x86_64 support is experimental. Offline checks run on Linux and macOS. Install Node 22+, npm and Python 3.11+; CI uses `.nvmrc` and Python 3.13.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci --prefix desktop
npm ci --prefix pi
make check PYTHON=.venv/bin/python
make desktop
```

For test-only installs, set `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. Each component owns its lockfile; dependency updates must include both manifest and lockfile. Do not add a root npm lockfile that duplicates their ownership.

## Daily workflow

- Run `make check` before submitting: Ruff, shellcheck when locally installed, Prettier, syntax checks and all offline unit tests. It does not operate the VM, access accounts or approve model requests. OAuth tests require a loopback listener.
- `make format` uses Ruff for Python and Prettier for `desktop/` and `pi/`; see `ruff.toml` and component `.prettierrc.json` files. Avoid unrelated repository-wide formatting in security changes.
- Keep cell UID mapping and Node/Pi versions in `guest/cell.env`. Transport limits in `services/common.py`, `pi/limits.mjs` and `desktop/src/shared/protocol.cjs` are checked for consistency. Do not duplicate these literals elsewhere.
- Live VM checks use `make verify-vm`. Gmail/model checks are explicit and excluded from default CI.
- Permission-related IPC changes must update controller allowlists, boundary tests, documentation and the renderer. Do not add generic shell or file proxies.
- Validate native picker paths in the main process. A saved directory plan is not an active grant. Only show authorization after broker activation. Startup restoration requires matching device and inode; otherwise leave the grant inactive with a reason. Cover read-only behavior, escape denial, revocation and failed restoration.
- New configuration needs a schema, validation and migration rules. Preserve corrupt or unknown-version files rather than silently overwriting them.
- Update capability documentation when behavior changes. Distinguish prototypes, implemented features and future plans.

## Documentation

Write documentation in English. `README.md` is the single project overview; do not maintain language-specific duplicates. Link task-specific guides from [docs/README.md](docs/README.md). Keep current guides directly under `docs/`, architecture under `docs/architecture/`, and release procedures under `docs/engineering/`. Keep maintained documentation aligned with the current implementation. Remove superseded proposals and dated acceptance reports; use Git history for historical context. Document verification commands and current limitations rather than old test totals.

Keep commands, paths, protocol fields and configuration keys exact. UI labels in the app may remain localized; English documentation describes the corresponding control. Update relative links and heading anchors whenever a document moves or a heading changes.

## Test layers

| Layer | Location | Dependencies and purpose |
|---|---|---|
| Service boundaries | `tests/` | Python + cryptography; mocked networking and policy |
| Pi protocol | `pi/tests/` | Node + Pi SDK; sessions, cancellation and input validation |
| Desktop behavior | `desktop/tests/` | Node; approvals, transactional configuration, RPC lifecycle, IPC origin and packaging |
| Live isolation | `guest/check-*.py`, `scripts/verify.sh` | Deployed VM; OS-boundary checks |
| Manual desktop acceptance | [Desktop guide](docs/DESKTOP_APP.md) | Windows, native pickers and real connections; real model requests require user authorization |

## Releases

Follow the [release guide](docs/engineering/RELEASE.md). Never commit `artifacts/`, `node_modules`, credentials, mail bodies or real user sessions. Contributions are licensed under [Apache-2.0](license.md); ensure you have the right to contribute and retain third-party notices.
