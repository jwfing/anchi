---
name: anchi-add-runtime
description: Plan and implement support for a new agent runtime in Anchi (beside Codex and Claude Code), such as another coding-agent CLI or SDK. Lists every place a runtime is wired in — schema, cell runner adapter, base image, credentials and egress rules, setup, TUI, builder, docs and live checks. Use when someone asks how to support another agent.
---

# Adding an agent runtime

A runtime is the agent program that runs a turn inside a task cell. Codex (`codex`) and Claude Code (`claude-code`) are the two today; follow how Claude Code was added. Settle these questions before you write code. Ask the user when the answers are unclear:

- **How does it run headless?** An SDK or a CLI mode that takes a prompt, streams events (messages, tool calls, usage) and can resume a session. Without resume, follow-up turns lose context.
- **Which credential does it use, and against which hosts?** A subscription token, an API key or OAuth. The credential stays in the vault, and the proxy substitutes a placeholder on the runtime's API hosts only. A runtime that must hold a real credential in the process, or that signs requests itself, cannot be supported as is.
- **Can it be told to use MCP over stdio?** Anchi tools (delegation, task status, connector tools) reach the runtime through the in-cell MCP server `/opt/anchi/mcp.mjs`.
- **Does it honor `HTTPS_PROXY` and a custom CA** (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`)? Cells have loopback-only networking.
- **Can its own sandbox, auto-update, telemetry and settings files be turned off?** The cell is the boundary, and the image is pinned.

## Touchpoints

| Layer | What to change |
|---|---|
| Ids | `runtimeSchema` in `core/src/config/schema.ts`, `runtimeIdSchema` in `protocol/src/cell.ts`, the runtime unions in `protocol/src/rpc.ts` |
| Base image | Download and verify the pinned binary in `guest/anchi-build-base.sh`; add the version and per-architecture SHA-256 to `guest/cell.env` (see `anchi-guest-change`) |
| Cell runner (untrusted) | An adapter like `cell-runner/src/claude.ts` that maps the runtime's events to `RuntimeEvent`s (message, tool call, usage, progress, error), honors the abort signal and resume id, and registers the Anchi MCP server; select it in `cell-runner/src/main.ts`. Pin any SDK in `anchi/pnpm-lock.yaml`. Host packages must not import it (`check-deps.mjs`) |
| Cell environment | `cell_environment()` in `guest/anchi_cell.py`: `PATH`, config home under `/home/agent`, the placeholder variable, and switches that turn off auto-update and telemetry; validate the runtime argument of `anchi-cell start` |
| Credentials | A `*_admin.py` in `services/` that stores the token in the vault over stdin (like `claude_admin.py`), the `auth.py` operation that hands it only to `egress`, and the setup command in `daemon/src/setup.ts` and the CLI |
| Egress | A rule in `services/egress_rules.py` that substitutes the placeholder on the runtime's API hosts only and denies its token-exchange and admin endpoints; add its hosts to the runtime host list, so an agent's `egress` list always allows them; quota headers in `egress_proxy.py` if it reports limits |
| Daemon and TUI | Connection status in **Runtimes** (`daemon/src/setup.ts`, `tui/src/tui/usability.ts`), models and efforts in the settings panel (`tui/src/tui/settings.ts`), usage and quota (`daemon/src/quota.ts`) |
| Builder | The runtime and its models in the system prompt in `daemon/src/builder.ts`, and the connected-runtime warning |
| Tests | Adapter event mapping in `cell-runner/test/runner.test.ts` (no network); egress substitution and refusals in `tests/test_egress.py` (the placeholder is replaced only on its hosts, a real-looking token from the cell is not replaced and is reported); schema cases in `core/test/config.test.ts` |
| Live checks | `guest/check-anchi.py`: the binary runs in a cell, the cell's environment and files hold no real credential |
| Docs | `README.md` status table, `SECURITY.md` (how its credential is handled), `docs/AGENT_TEAM.md` (connect and choose it), `docs/architecture/AGENT_TEAM_CONTRACTS.md` (`RUNTIME` argument, `runtime` field), the landing page's runtimes section, `CHANGELOG.md` |

Start with a design note in the PR or an issue that answers the questions above. A runtime needs its own credential handling and proxy rule, so it is a security-boundary change (`anchi-security-boundary`).
