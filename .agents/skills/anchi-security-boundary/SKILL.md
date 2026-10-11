---
name: anchi-security-boundary
description: Rules and checklist for changes that touch an Anchi security boundary — credentials, the vault, task cells, the egress proxy, connector services, approvals, policy, workspaces, skills or anything the cell runner sends. Use whenever a change could let a cell see a secret, reach something new, or skip an approval.
---

# Changing a security boundary

Read `SECURITY.md` (trust zones and the agent-team section) first. The invariants:

- Upstream credentials never enter a task cell. Cells hold placeholders; the egress proxy (`services/egress_proxy.py`, rules in `services/egress_rules.py`) injects or re-signs on matching requests only, and never adds a credential to a request that did not carry a placeholder.
- Everything in a cell is untrusted: the runtime, its tools, the cell runner, the in-cell MCP server, skills, session files and model output.
- Secrets reach the VM on stdin only. Never in argv, host environment, logs, errors or fixtures, and they never come back to the host.
- A cell reaches only its own proxy socket and its agent's bridge sockets. It never sees a service socket, the auth socket, policy administration or another agent's socket.
- The daemon decides what an Anchi tool call may do from the task and agent bound to the cell's runner channel, never from what the cell says about itself.
- Writes through connectors follow the configured authorization mode and the per-agent `approvals`; an approval binds to the exact content shown.

## Checklist

1. **Name the boundary** your change touches and who is on each side. If you cannot, ask before writing code.
2. **Validate input from the untrusted side** with a schema (`zod` in TypeScript), bound sizes and counts, reject unknown fields (`z.strictObject`), and end the cell on the first violation where the code already does.
3. **Fail closed.** Unknown connector, host, operation, account or id → refuse with a stable error code (`BAD_…`, `…_DENIED`), not a default.
4. **Write the refusal test first**: a test that fails if the boundary breaks (the cell sends a forged agent name, a path with `..` or a symlink, an oversize frame, a credential of its own, a write without a grant). Happy-path tests alone are not enough.
5. **Sanitize agent text** before display (`sanitize`/`sanitizeLine` in `tui/src/sanitize.ts`); hosts and paths in the audit log come from agents too.
6. **Audit**: new egress decisions are recorded in the audit row with method, host, path, operation, decision, task and agent, never header values or query strings.
7. **Update `SECURITY.md`** in the same change when the boundary's behavior changes, and the live checks (`guest/check-anchi.py`, `guest/check-*.py`) when the VM side changes.

## Things that look harmless and are not

- Adding a field to a runner frame or tool result without a size bound.
- Passing a value from a cell into a shell command or a guest command line; guest commands take fixed arguments validated by regex in `guest/anchi_cell.py`.
- Logging a request or an environment for debugging.
- Making a test pass by widening an allowlist, or by mocking away the check under test.
- Bind-mounting a new host path into cells; workspaces are checked in the daemon and again in the cell manager (no `..`, no symlinks on the way).
