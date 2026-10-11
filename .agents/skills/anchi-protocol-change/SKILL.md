---
name: anchi-protocol-change
description: How to add or change an Anchi RPC method, event or cell-runner frame so the protocol, daemon, TUI, CLI, tests and contracts stay in step. Use when editing anchi/packages/protocol or adding a daemon handler, CLI command or TUI action that calls the daemon.
---

# Changing the protocol

The protocol package is the contract between the TUI/CLI and the daemon (`src/rpc.ts`, `src/events.ts`) and between the daemon and the cell runner (`src/cell.ts`). Change all sides in one commit.

## Client ↔ daemon RPC

1. **Type it** in `anchi/packages/protocol/src/rpc.ts`: add result interfaces near the related ones and the method to the RPC map as `'area.verb': [Params, Result]`, with a doc comment that says what it changes and what it refuses.
2. **Handle it** in `anchi/packages/daemon/src/daemon.ts` (`handlers`). Parameters come from a local socket client but are still validated: use the existing helpers (`str(value, 'name', maxLength)` and friends), bound every string and array, and call `this.hub.reload()` when configuration changed.
3. **Call it** from the TUI (`anchi/packages/tui/src/tui/App.tsx`, through `client.call`) and, if it is a user action, from the CLI (`anchi/packages/tui/src/main.ts`, `commander`). Pass agent-provided text through `sanitize`/`sanitizeLine` before printing.
4. **Key bindings**: a new TUI action gets an id in `tui/src/tui/keys.ts`, a default binding, an entry in the help menu and a line in `docs/KEYBINDINGS.md`.
5. **Test** the handler in `anchi/packages/daemon/test/daemon.test.ts` (it runs a real daemon over a fake guest) including the refusal path, and the TUI flow in `anchi/packages/tui/test/tui.test.tsx` with a stubbed client.
6. **Document** the method in `docs/architecture/AGENT_TEAM_CONTRACTS.md` and the user-facing behavior in the guide (`docs/AGENT_TEAM.md` or a sibling), plus a `CHANGELOG.md` line.

Changing a result shape is a breaking change for every caller: search for `'area.verb'` across `anchi/packages` and update them all.

## Daemon ↔ cell runner frames

Frames in `src/cell.ts` cross the trust boundary: the runner is untrusted. Every new frame needs a schema with bounded fields, a check that it belongs to the running turn, and a daemon test where a malformed or out-of-turn frame ends the cell. Follow `anchi-security-boundary`.

## Guest commands

The daemon reaches the VM only through fixed `anchi-cell` / `anchi-image` commands (`daemon/src/guest.ts`, `guest/anchi_cell.py`). A new command validates every argument by regex in the guest, takes secrets on stdin, prints JSON, and is listed in the contracts table.
