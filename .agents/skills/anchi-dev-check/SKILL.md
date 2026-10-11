---
name: anchi-dev-check
description: Set up the Anchi development environment and run the offline checks (Ruff, shellcheck, Prettier, typecheck, trust-zone dependency check, vitest, Python unittest). Use before finishing any change in this repository, when a check fails, or when asked how to test.
---

# Develop and check Anchi

## Set up once

```bash
pnpm --dir anchi install                     # Node 22+ (.nvmrc), pnpm from anchi/package.json
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
```

## Before you report a change as done

```bash
make check PYTHON=.venv/bin/python
```

It runs, in order: Ruff lint and format check on `services scripts guest tests`, shellcheck when installed (CI always runs it), `scripts/check-source.py` (Python and shell syntax), then `pnpm --dir anchi run check` (trust-zone dependency check, `tsc`, Prettier check, vitest), then the Python `unittest` suite. Nothing touches the VM, accounts or models; some tests open loopback listeners.

Report the result as it is. If a check fails for a reason unrelated to your change, say so with the output instead of working around it.

## Faster loops

| Goal | Command |
|---|---|
| One TypeScript test file | `pnpm --dir anchi exec vitest run packages/daemon/test/skills.test.ts` |
| Tests matching a name | `pnpm --dir anchi exec vitest run -t 'skill updates'` |
| Typecheck only | `pnpm --dir anchi run typecheck` |
| Trust-zone imports | `pnpm --dir anchi run deps` |
| One Python module | `.venv/bin/python -m unittest tests.test_egress` |
| Fix formatting | `make format PYTHON=.venv/bin/python` (format only files you changed if the rest is clean) |
| Run the CLI/TUI from source | `pnpm --dir anchi anchi -- --help` |

## Where tests go

| Change | Test |
|---|---|
| Schemas, codec (`protocol`) | `anchi/packages/protocol/test/` |
| Agent, image, trigger config (`core`) | `anchi/packages/core/test/config.test.ts` |
| Daemon behavior | `anchi/packages/daemon/test/`; `daemon.test.ts` runs the real daemon with `FakeTransport` and `fixtures/fake-runner.mjs` instead of a VM |
| TUI rendering and keys | `anchi/packages/tui/test/` with `ink-testing-library` (`tui.test.tsx`, `keys.test.ts`) |
| Cell runner | `anchi/packages/cell-runner/test/runner.test.ts` |
| Trusted VM services, egress rules | `tests/test_*.py` (mocked network and policy) |
| Cell manager pure functions | `tests/test_guest.py` loads `guest/anchi_cell.py` directly |

## Live checks (only when asked)

`make verify-vm`, `make verify-anchi` and `scripts/anchi-acceptance.sh` need a running `secure-vm`; the last uses real accounts. They refuse while task cells are live. If a change affects the VM and you could not run them, say which live check would cover it.
