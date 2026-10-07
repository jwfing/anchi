# Agent team contracts

These are the interfaces between the parts of the [agent team](AGENT_TEAM_DESIGN.md): the agent configuration, and the three channels that cross a process or trust boundary. The types and zod schemas live in `anchi/packages/protocol` and `anchi/packages/core`; this document explains them.

```text
TUI ──(1) client socket──▶ daemon ──(2) limactl shell + sudo, fixed commands──▶ guest root
                             ▲                                                     │
                             └────(3) runner stdin/stdout, through (2)──── cell runner (untrusted)
```

## Agent configuration

Agents are YAML files in `~/.anchi/agents/<id>.yaml`. The file name is the id: 1–40 lowercase letters, digits or `-`. An agent can `extend` a template in `~/.anchi/templates/`; objects merge key by key, and arrays and scalars replace.

| Field | Default | Meaning |
|---|---|---|
| `name`, `description` | id, none | Shown in the TUI |
| `runtime` | required | `codex` (phase 1) |
| `model`, `effort` | runtime default | Passed to the runtime |
| `prompt` | `{mode: append, text: ''}` | `text` or `file` (relative to the declaring file). `replace` replaces the runtime's base instructions |
| `connectors` | `[]` | Any of `github`, `aws`, `linear`. The proxy injects credentials only for these |
| `image` | `codex` | An image recipe id in `~/.anchi/images/`, or the built-in `codex` image |
| `network` | `proxy` | Reserved; `proxy` is the only value in phase 1 |
| `sandbox` | `cell` | `cell`: Codex runs `danger-full-access` and the cell is the boundary. `codex-workspace-write`: Codex's own sandbox as well; needs the per-agent AppArmor opt-in |

Unknown fields are errors. my-bot's `account`, `workspace` and `tools` fields are rejected: there are no host accounts, host working directories or host tool lists.

Image recipes are YAML files in `~/.anchi/images/<id>.yaml`:

| Field | Meaning |
|---|---|
| `from` | Always `codex` |
| `packages` | Debian package names, installed with `apt-get` |
| `run` | Shell commands run as root in the build cell, after the packages |

The recipe's content hash names the built layer. A changed recipe is a new image, built again.

## (1) Daemon ⇄ client

JSON-RPC over `~/.anchi/run/daemon.sock` (mode 0600). Newline-delimited JSON frames of at most 8 MiB. Request `{id, method, params}`, response `{id, result}` or `{id, error: {message}}`, notification `{method, params}`. The method table is `Methods` in `protocol/src/rpc.ts`.

- **Tasks:** `tasks.create`, `tasks.send` (a follow-up turn), `tasks.cancel`, `tasks.list`, `tasks.get`, `tasks.events`, `tasks.wait`, and `tasks.scan` (credential-invariant scan of the task's live cell).
- **Agents and builder:** `agents.list`, `agents.reload`, `builder.proposal`, `builder.apply`, `builder.discard`. `builder.apply` is the only method that writes agent or image files. The TUI calls it only after a confirmation modal.
- **Setup and connectors:**
  - `setup.status` and `setup.importCodex`;
  - `connectors.set` carries a secret. The daemon writes it to the guest administration command's stdin and never stores or logs it. It then verifies the connector, records the account it reports, and removes a credential the service refuses.
- **Notifications:** `event` (runtime event of a task), `tasks`, `agents`, `proposal`.

Every string in a runtime event is agent-originated. Clients must strip control characters and escape sequences before display.

## (2) Daemon ⇄ guest administration

The daemon runs only fixed commands: `limactl shell secure-vm -- sudo <command>`. Secrets travel on stdin only, never in arguments. Every command prints one JSON object, or `{"error": CODE}` with a non-zero exit.

| Command | Purpose |
|---|---|
| `anchi-cell start TASK AGENT IMAGE HASH CONNECTORS SANDBOX` | Start a task cell and run the cell runner in it. Stdin and stdout are channel (3). Blocks until the cell exits, then releases its overlay, sockets and proxy registration |
| `anchi-cell stop TASK` | Stop a cell and release its overlay, sockets and proxy registration |
| `anchi-cell list` | Running cells, as JSON |
| `anchi-cell reap [TASK...]` | Stop every cell not named, and unmount stale overlays |
| `anchi-cell scan TASK` | Credential-invariant scan of a running cell: environment, process list and writable layer |
| `anchi-cell verify CONNECTOR` | Has the egress proxy call the connector's identity endpoint (GitHub `/user`, Linear `viewer`, AWS `GetCallerIdentity`) with the stored credential. Prints the account, or `CREDENTIAL_REJECTED` |
| `anchi-cell exec TASK -- COMMAND...` | Run a command as the agent user in a running cell, for live checks |
| `anchi-image status ID HASH` | Whether a built layer exists for this recipe hash (and the current base) |
| `anchi-image build ID HASH` | Build an image layer from the recipe JSON on stdin (`codex base` builds the built-in image). Prints metadata and the build log path |
| `anchi-image list` / `anchi-image remove ID` | Image layers and their metadata |
| `python3 /opt/secure-vm/services/admin.py import-token\|import-aws\|disconnect\|status CONNECTOR` | Connector credentials into and out of the vault |
| `python3 /opt/secure-vm/services/codex_admin.py import-token\|status` | Codex access token and account id into the vault; status without secrets |
| `python3 /opt/secure-vm/services/vault_admin.py status` | Whether the vault is unlocked |

`TASK`, `AGENT` and `IMAGE` match `^[a-z0-9][a-z0-9-]{0,39}$`. `HASH` is `base` or the recipe's 16-hex content hash. `CONNECTORS` is a comma-separated subset of `github,aws,linear`, or `-` for none. `SANDBOX` is `cell` or `codex-workspace-write`.

## (3) Cell runner ⇄ daemon

The runner is `/opt/anchi/runner.mjs` in the image. It runs as the agent user, with its stdin and stdout connected to the daemon through `anchi-cell start`. One runner serves one task and runs one turn at a time. The schemas are in `protocol/src/cell.ts`.

- **Daemon → runner:**
  - `{type: run, turn, input, resumeId?, options}`, where options are `model`, `effort`, `instructions`, `instructionsMode`, `sandbox` and `workdir`;
  - `{type: cancel, turn}`.
- **Runner → daemon:**
  - `{type: ready, protocol: 1, runtime, version}` once at start;
  - `{type: event, turn, event}`;
  - `{type: turn.end, turn, ok}`.

The runner is untrusted. The daemon:

- caps each frame at 256 KiB;
- validates every frame against the schema;
- accepts events only for the turn in progress;
- ends the cell on the first violation.

The runner truncates tool output to 16 KiB and other text to 64 KiB before sending, so that a valid runner never hits the daemon's limits.

Closing the runner's stdin ends the runner and therefore the cell. The daemon does this after the idle timeout and on cancellation of the task.
