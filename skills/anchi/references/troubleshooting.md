# Troubleshooting

Start with `anchi setup status` (a summary; `--json` for every field) and `anchi daemon status`. Errors from the VM carry a code and usually a hint, as in `cell start failed: HERMES_NOT_CONFIGURED — …`; the codes below are the common ones. Fixes that change an agent's limits or a connector need the user's agreement (rules 3 and 4 in SKILL.md).

## A task does not start

| Message | Cause | Fix |
|---|---|---|
| `CODEX_NOT_CONFIGURED` | No Codex login in the vault | `codex login` on this computer, then `anchi setup codex` |
| `CLAUDE_NOT_CONFIGURED` | No Claude Code token | `claude setup-token`, then `anchi setup claude` |
| `HERMES_NOT_CONFIGURED` | No Hermes endpoint | `anchi setup hermes --base-url … --model …` |
| `BASE_IMAGE_NOT_BUILT` | Installation did not finish | `anchi setup install` |
| `RUNTIME_IMAGE_NOT_BUILT` | The runtime's layer is missing | Start the task again; it builds the layer |
| `IMAGE_BUILD_FAILED` | A recipe's `packages` or `run` failed | Read the build log tail in the task; fix the recipe in `~/.anchi/images/` |
| `TOO_MANY_CELLS` | The task waited 10 minutes in line for a cell (`maxCells` working, default 4) | Retry when tasks finish (`anchi retry <task>`); idle cells close after 10 minutes. The user may raise `maxCells` in `settings.yaml` after giving the VM more memory |
| `EGRESS_UNAVAILABLE` | The VM's proxy is down | `anchi setup install` |
| `AGENT_HOME_LINK:<path>` | A link, file or directory sits where Anchi writes `<path>` in the agent's home (`.codex/auth.json`, `.codex/config.toml`); the cell is refused rather than written through it | `limactl shell anchi-vm -- sudo rm -rf /var/lib/anchi/agents/<agent>/home/<path>` (a link is removed, not followed), or delete the agent, which purges its home |
| `WORKSPACE_TOO_MANY_MASKS:<name>` | The `rw` workspace has more git hooks, config and editor folders than Anchi masks read-only (1000) | Share a smaller folder, or make it `ro` |
| `DISK_FULL` | The VM's disk has under 512 MB free | Free space in the VM (`limactl shell anchi-vm -- sudo du -sh /var/lib/anchi/*`: agents' homes, image layers), or recreate the VM with a larger disk |
| Vault locked | The VM restarted | `anchi setup vault unlock` |
| VM `stopped` or `missing` | | `anchi setup vm` (then unlock), or `anchi setup install` |
| An agent file error in `anchi agents` | Unknown field, bad id or value | Fix the YAML; the message names the field |
| `skill "<id>" is not installed` | The agent file names a skill that is not installed (edited files are not checked for it) | `anchi skills add …`, or remove it from `skills` |

## A task runs but cannot do something

- **`anchi: <host> is not in this agent's egress list`**: the agent has an `egress` list without that host. `anchi agents allow-host <agent> <host>`, or editing the list, only after the user agrees.
- **`anchi: <operation> denied`**: a rule refuses it on purpose (credential minting, account administration, Gmail writes). It is not something to work around.
- **`approval for this write timed out / was denied`**: the write was held (`approvals: ask` or a high-risk operation) and nobody approved it in time. `anchi approvals` while it waits.
- **`CODEX_TOKEN_EXPIRED_REIMPORT_ON_HOST`** when the model is called: the Codex login imported into the vault expired. Run `codex` once on this computer so it refreshes; the daemon re-imports it (or `anchi setup codex`, with the user's agreement).
- **401 from a service**: the stored credential no longer works. Reconnect it (`anchi setup connector github`, `anchi setup service gmail`…); Google accounts that need signing in again show it in `anchi setup status`.
- **Files in a workspace are missing**: `anchi setup workspaces` shares `~/AnchiWorkspaces` once (it restarts the VM); the agent needs the directory in its `workspaces`.

## Finding out what happened

- `anchi tasks -a <agent> -s failed` lists failures; `anchi run`/`send`/`retry` with `-v` shows tool output.
- `anchi audit <task>` shows every host the task's cells contacted, what the proxy injected or refused, and whether a cell sent a credential of its own (which Anchi flags: its own credentials never enter a cell).
- The daemon log is `~/.anchi/data/daemon.log`.

## Updating and starting over

- `anchi update` installs the latest release; then `anchi setup install` updates the VM's components (it refuses while task cells are live). Until that has run, `anchi setup status` says `Components: installed by Anchi <old>; this is <new>` (`--json`: `guestOutdated`, `guestVersion`, `appVersion`), Getting started and Runtimes ask for it, and each new task starts with a notice saying so: that notice, not the task, is what to act on.
- `anchi setup status` saying `Could not ask the VM: …`: a guest command failed while the VM runs; the other fields are unknown. Try again; if it keeps failing, `anchi setup install` (with the user's go-ahead) reinstalls the guest components and keeps agents and credentials.
- After an update, the first task may rebuild the base and runtime image layers (a few minutes).
- `anchi setup reset` deletes the VM, its vault contents and agent homes, for a fresh start, and refuses while tasks run or wait; `--all` also deletes the vault key and `~/.anchi` (keeping `keybindings.json`). Workspace files on the user's computer are never deleted. Only with the user's go-ahead.
