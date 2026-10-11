# Anchi: instructions for coding agents

This file is for coding agents (Codex, Claude Code, Cursor, Gemini CLI and others) working in this repository. Human contributors follow [CONTRIBUTING.md](CONTRIBUTING.md); this file sums it up and adds what agents get wrong. Task-specific procedures are skills in [`.agents/skills/`](.agents/skills) (Claude Code reads the same files through `.claude/skills`).

Anchi is a secured agent team: a trusted daemon and TUI on the host, a Lima VM with trusted services, and untrusted task cells in the VM. Most of the code exists to keep a boundary, so read [SECURITY.md](SECURITY.md) and [the repository map](docs/architecture/REPOSITORY.md) before changing anything that touches credentials, cells, egress, approvals or policy.

## Layout and trust zones

| Path | Zone | Language |
|---|---|---|
| `anchi/packages/protocol`, `core`, `daemon`, `tui` | Trusted, host | TypeScript (Node 22+, pnpm workspace) |
| `anchi/packages/cell-runner` | **Untrusted**, inside task cells | TypeScript |
| `services/` | Trusted, VM (vault, auth, policy, egress proxy, connectors) | Python 3.11+ |
| `guest/`, `systemd/`, `lima/` | VM bring-up, cell manager (`anchi_cell.py`), version pins (`cell.env`) | Shell, Python |
| `scripts/` | Host entry points and live checks | Shell, Python |
| `tests/` | Offline tests of the trusted services | Python `unittest` |
| `landing/` | Static landing page, not the product | HTML/CSS/JS |
| `docs/` | Guides (`docs/`), architecture (`docs/architecture/`), release (`docs/engineering/`) | English Markdown |

Host packages never import a runtime SDK or the cell runner, and the cell runner never imports a host package; `anchi/scripts/check-deps.mjs` enforces this.

## Commands

```bash
pnpm --dir anchi install                       # once
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-test.txt
make check PYTHON=.venv/bin/python             # everything CI runs, offline
make format PYTHON=.venv/bin/python            # ruff + prettier
pnpm --dir anchi exec vitest run packages/daemon/test/skills.test.ts   # one TS test file
.venv/bin/python -m unittest tests.test_guest  # one Python test module
```

`make check` never starts the VM, uses an account or calls a model. Live checks (`make verify-vm`, `make verify-anchi`, `scripts/anchi-acceptance.sh`) are explicit and need a running VM. Do not run them unless the user asks.

## Rules

1. **Run `make check` before you say a change is done**, and report failures as they are. Do not weaken or delete a test to make it pass.
2. **Boundary changes need a test that fails if the boundary breaks.** That covers credentials, cells, egress, approvals, policy and workspaces. Test the refusal path, not only the happy path. See the `anchi-security-boundary` skill.
3. **Everything from a cell is untrusted**: runner frames, tool calls, agent text, skills, session files. Validate with a schema, bound sizes and counts, and strip control characters before display.
4. **Secrets go to the VM on stdin only.** Never put them in arguments, environment variables of host processes, logs, test fixtures or error messages.
5. **Pins live in `guest/cell.env`** (cell UIDs, Node, Codex, Claude Code, base-image toolchains), each with its SHA-256. Do not repeat these literals elsewhere. Dependency updates change both `package.json` and `anchi/pnpm-lock.yaml` and respect pnpm's minimum release age: pin an older version instead of adding a `minimumReleaseAgeExclude`.
6. **Protocol changes span every caller.** A change to `protocol/src/rpc.ts` updates the daemon handler, the TUI and the CLI (`tui/src/main.ts`), their tests and `docs/architecture/AGENT_TEAM_CONTRACTS.md`. See `anchi-protocol-change`.
7. **New agent configuration fields** need a schema in `core`, validation, the settings panel or a read-only display, the builder prompt when the builder should know it, and documentation in the contracts. See `anchi-agent-config-field`.
8. **Write state atomically** (temporary file, then rename). Tasks, events and trigger state are in SQLite.
9. **Match the surrounding code.** TypeScript: single quotes, 100 columns, trailing commas (Prettier). Python: Ruff, 4 spaces. Short doc comments that say why, in the same voice as nearby code. No new dependencies without a reason in the PR.
10. **Keep the scope.** No repository-wide reformatting or unrelated refactors, especially in security changes.

## Documentation and changelog

User-visible changes get a line in `CHANGELOG.md` under `## Unreleased` (`Added`, `Changed`, `Fixed`, `Removed`), and the guide that describes the behavior is updated in the same change. Documentation is in English, describes what is implemented now, and keeps commands, paths, protocol fields and configuration keys exact. See `anchi-docs`.

## Commits and pull requests

Branch from `main` (`feat/…`, `fix/…`, `docs/…`). Commit messages follow Conventional Commits with an optional scope: `feat(tui): …`, `fix(vm): …`, `docs: …`, `chore(release): …`. A PR describes the problem, the resulting behavior, the checks run and what was not tested (live VM, real accounts). Never commit `artifacts/`, `node_modules/`, credentials, mail bodies or real user sessions.
