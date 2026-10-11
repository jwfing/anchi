---
name: anchi-agent-config-field
description: Add or change a field of an Anchi agent file (~/.anchi/agents/*.yaml) or image recipe end to end — schema, validation, daemon use, settings panel, builder prompt and contracts docs. Use when an agent needs a new setting or an existing setting changes meaning.
---

# Adding an agent configuration field

Agent files are YAML in `~/.anchi/agents/`; recipes are in `~/.anchi/images/`. A field is done when the user can see it, the builder knows it, invalid values are refused and the contracts describe it.

1. **Schema** in `anchi/packages/core/src/config/schema.ts`: add it to the agent layer schema (`z.strictObject`, so unknown keys stay errors) with bounds, a default only if omission has an obvious meaning, and a doc comment. Templates merge into agents, so decide whether the field inherits.
2. **Validation against what exists** (installed skills, connectors, directories, delegates) belongs in the daemon, where proposals and settings changes are checked: missing things block, unconnected connectors warn.
3. **Use it** in the daemon (`hub.ts`, `cell.ts`, `launch.ts`). If it reaches the VM, it is passed as a validated `anchi-cell start` argument; see `anchi-protocol-change` and `anchi-security-boundary`. Cells of an older guest must refuse rather than silently ignore a security-relevant field.
4. **Settings panel**: editable fields go through `agents.update` (`daemon/src/settings.ts`) and the TUI settings panel (`tui/src/tui/settings.ts`), which shows a diff and writes only after confirmation, keeping the rest of the file and its comments. Fields the panel cannot edit are still shown read-only.
5. **Builder**: if the builder should propose it, describe it in the system prompt in `daemon/src/builder.ts` and, for patchable fields, in the `anchi-agent-patch` handling.
6. **Tests**: schema accept/refuse cases in `core/test/config.test.ts`; daemon behavior in `daemon/test/daemon.test.ts`; panel rendering in `tui/test/settings.test.ts` / `tui.test.tsx`.
7. **Docs**: the field table in `docs/architecture/AGENT_TEAM_CONTRACTS.md` (default, meaning), usage in `docs/AGENT_TEAM.md`, a `CHANGELOG.md` line, and `SECURITY.md` if it widens or narrows what an agent can do.
