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
| `runtime` | required | `codex` or `claude-code` |
| `model`, `effort` | runtime default | Passed to the runtime |
| `prompt` | `{mode: append, text: ''}` | `text` or `file` (relative to the declaring file). `replace` replaces the runtime's base instructions |
| `connectors` | `[]` | `github`, `aws`, `linear`: the proxy injects credentials only for these. `gmail`, `drive`, `notion`, `slack`: reached through per-cell bridge sockets at `/run/anchi/connectors/<id>/api.sock`, which name the agent to the service |
| `image` | `codex` | An image recipe id in `~/.anchi/images/`, or the built-in `codex` image |
| `network` | `proxy` | Reserved; `proxy` is the only value in phase 1 |
| `sandbox` | `cell` | `cell`: the runtime runs without its own sandbox and the cell is the boundary. `codex-workspace-write` (Codex only): Codex's own sandbox as well; needs the per-agent AppArmor opt-in |
| `delegates` | `[]` | Agents this agent may delegate tasks to; not itself |
| `approvals` | `{}` | Per connector, `ask` holds the agent's writes for the user: in the proxy for `github`, `aws`, `linear`; in the policy service, as the principal `<connector>:<agent>`, for `gmail`, `drive`, `notion`, `slack` |
| `triggers` | `[]` | `{schedule: '<cron>', text}` or `{poll: {type: linear-issues, team?, label?, state?} \| {type: github-issues, query}, text, every?}`; `text` may use `{title}`, `{url}`, `{id}` |
| `skills` | `[]` | Skill ids in `~/.anchi/skills/` |
| `egress` | none (open) | Host patterns (`example.com`, `*.example.com`) the cells may reach, besides the runtime's and the connectors' hosts |
| `workspaces` | `[]` | `{path, mode: ro\|rw, name?}`: directories under `~/AnchiWorkspaces`, bound at `/home/agent/workspaces/<name>` (macOS) |

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

- **Tasks:** `tasks.create`, `tasks.send` (a follow-up turn), `tasks.retry` (a failed or cancelled task: continue its session, or `fresh` for a new task with the same request), `tasks.cancel`, `tasks.list`, `tasks.get`, `tasks.events`, `tasks.wait`, `tasks.scan` (credential-invariant scan of the task's live cell), and `tasks.audit` (the task's rows of the egress audit log, summarized: hosts and decisions, injections by rule, credentials the cell sent, refusals, held writes, bridge calls, its registration, the latest 500 requests).
- **Usage:** `usage.summary {since?, by?}` (token totals of turns since a time, by `agent`, `runtime`, `model` or `day`) and `usage.quota` (the subscription limits the egress proxy last saw, per runtime: Codex's plan and windows, Claude Code's rate-limit headers).
- **Agents and builder:** `agents.list`, `agents.reload`, `agents.settings`, `agents.update`, `agents.deletePreview`, `agents.delete` (the id typed by the user confirms it), `builder.proposal`, `builder.revise`, `builder.apply`, `builder.discard`. Only `builder.apply` and `agents.update` with `apply` write agent or image files, and the TUI calls them only after a dialog showing the change. `agents.update` changes `skills`, `connectors` and `workspaces` of an agent file, keeping the rest; with `apply` it requires the digest (`base`) of the file the reviewed diff was made from. Proposals and settings changes are checked against what exists: missing skills, delegates or directories block, connectors not yet connected warn.
- **Setup and connectors:**
  - `setup.status` and `setup.importCodex`;
  - `setup.run` runs one setup step at a time: `vm-start`, `install`, `vault-init` or `vault-unlock`. Each is a fixed host command from the checkout (`limactl start`, `scripts/up.sh` then `scripts/install-anchi.sh` then the base image build, `scripts/vault.py`). The vault key is read by `vault.py`, not by the daemon. Output lines arrive as `setup` notifications;
  - `connectors.importGh` imports the token of the host `gh` CLI; `connectors.awsProfile` imports the temporary credentials of a host AWS profile and keeps them refreshed (the profile name is kept in `~/.anchi/data/connectors.json`, no secret);
  - `connectors.set` carries a secret. The daemon writes it to the guest administration command's stdin and never stores or logs it. It then verifies the connector, records the account it reports, and removes a credential the service refuses.
- **Phase 2:**
  - `tasks.search` (agent, status, words, time), `tasks.tree`, `tasks.delete`;
  - `approvals.list`, `approvals.decide` (called only after a full-screen dialog);
  - `triggers.list`;
  - `skills.list`, `skills.add` (local directory or GitHub URL), `skills.remove`, `skills.checkUpdate` (what the latest commit of the URL changes, nothing written), `skills.update` (installs the commit the user reviewed);
  - `setup.importClaude`; `services.setToken`, `services.disconnect`, `services.setMode`, `services.googleClient`, `services.googleLogin`.
- **Notifications:** `event` (runtime event of a task), `tasks`, `agents`, `proposal`, `setup` (a line of setup output), `approvals`, `oauth`, `tasksDeleted`.

Every string in a runtime event is agent-originated. Clients must strip control characters and escape sequences before display.

## (2) Daemon ⇄ guest administration

The daemon runs only fixed commands: `limactl shell secure-vm -- sudo <command>`. Secrets travel on stdin only, never in arguments. Every command prints one JSON object, or `{"error": CODE}` with a non-zero exit.

| Command | Purpose |
|---|---|
| `anchi-cell start TASK AGENT IMAGE HASH CONNECTORS SANDBOX RUNTIME ASK WORKSPACES EGRESS` | Start a task cell and run the cell runner in it. Stdin and stdout are channel (3). Blocks until the cell exits, then releases its overlay, sockets and proxy registration |
| `anchi-cell approvals watch` | Streams the proxy's queue of held writes as JSON lines, until it ends |
| `anchi-cell approvals decide ID allow\|deny` | Answers a held write |
| `anchi-cell poll` | Runs a polling trigger's fixed read-only query (spec on stdin) in the egress service; prints the items |
| `anchi-cell skills set AGENT` | Replaces the agent's skill bundle (`{files: {path: base64}}` on stdin) |
| `anchi-cell purge-agent AGENT` | Removes a deleted agent's home, skills bundle and `<service>:AGENT` policy rules. Refused while the agent has a cell or a mount point exists under its home; removal does not cross file systems |
| `anchi-cell stop TASK` | Stop a cell and release its overlay, sockets and proxy registration |
| `anchi-cell list` | Running cells, as JSON |
| `anchi-cell reap [TASK...]` | Stop every cell not named, and unmount stale overlays |
| `anchi-cell scan TASK` | Credential-invariant scan of a running cell: environment, process list and writable layer |
| `anchi-cell verify CONNECTOR` | Has the egress proxy call the connector's identity endpoint (GitHub `/user`, Linear `viewer`, AWS `GetCallerIdentity`) with the stored credential. Prints the account, or `CREDENTIAL_REJECTED` |
| `anchi-cell audit TASK` | The task's rows of the egress audit log and its rotated file, the latest 2000, as JSON with their total |
| `anchi-cell quota` | The latest subscription limits the egress proxy saw in runtime responses, as JSON |
| `anchi-cell exec TASK -- COMMAND...` | Run a command as the agent user in a running cell, for live checks |
| `anchi-image status ID HASH` | Whether a built layer exists for this recipe hash (and the current base) |
| `anchi-image build ID HASH` | Build an image layer from the recipe JSON on stdin (`codex base` builds the built-in image). Prints metadata and the build log path |
| `anchi-image list` / `anchi-image remove ID` | Image layers and their metadata |
| `python3 /opt/secure-vm/services/admin.py import-token\|import-aws\|disconnect\|status CONNECTOR` | Connector credentials into and out of the vault |
| `python3 /opt/secure-vm/services/codex_admin.py import-token\|status` | Codex access token and account id into the vault; status without secrets |
| `python3 /opt/secure-vm/services/claude_admin.py import-token\|status\|disable` | Claude Code token or API key into the vault |
| `python3 /opt/secure-vm/services/admin.py import-client\|begin\|complete gmail\|drive` | Google OAuth client and sign-in (the code arrives on stdin; tokens stay in the VM) |
| `python3 /opt/secure-vm/services/connector_admin.py ID probe\|disconnect` | Service connector account label, or disconnect and revoke |
| `python3 /opt/secure-vm/services/policy_admin.py show\|approve\|deny\|mode\|clear\|rules` | Connector-service requests held by policy; modes per service (`notion`) and per agent (`notion:writer`) |
| `python3 /opt/secure-vm/services/vault_admin.py status` | Whether the vault is unlocked |

`TASK`, `AGENT` and `IMAGE` match `^[a-z0-9][a-z0-9-]{0,39}$`. `HASH` is `base` or the recipe's 16-hex content hash. `CONNECTORS` is a comma-separated subset of `github,aws,linear,gmail,drive,notion,slack`, or `-` for none. `SANDBOX` is `cell` or `codex-workspace-write`. `RUNTIME` is `codex` or `claude-code`. `ASK` is the subset of the connectors whose writes are held, or `-`; for connector services the cell manager sets or clears the agent's policy rule at start. `WORKSPACES` is base64url JSON `[{name, path, mode}]` or `-`; the cell manager checks again that each path stays under `/mnt/anchi-host` without symlinks or `..`. `EGRESS` is base64url JSON host patterns, or `-` for open egress.

## (3) Cell runner ⇄ daemon

The runner is `/opt/anchi/runner.mjs` in the image. It runs as the agent user, with its stdin and stdout connected to the daemon through `anchi-cell start`. One runner serves one task and runs one turn at a time. The schemas are in `protocol/src/cell.ts`.

- **Daemon → runner:**
  - `{type: run, turn, input, resumeId?, options}`, where options are `model`, `effort`, `instructions`, `instructionsMode`, `sandbox` and `workdir`;
  - `{type: cancel, turn}`;
  - `{type: tool.response, id, ok, result?, error?}`.
- **Runner → daemon:**
  - `{type: ready, protocol: 2, runtime, version}` once at start;
  - `{type: event, turn, event}`;
  - `{type: turn.end, turn, ok}`;
  - `{type: tool.request, turn, id, tool, args}`: an Anchi tool call from the in-cell MCP server.

The in-cell MCP server (`/opt/anchi/mcp.mjs`, started by Codex and Claude Code) relays calls to the runner over a cell-local socket; the runner tags them with the running turn. The daemon answers only calls of the turn in progress, at most 200 per turn, and decides what each may do from the task and agent it knows. Connector-service tools (`gmail_list`, `notion_create_page`, …) are served by the MCP server itself through the cell's bridge sockets; the bridge in `anchi-egress` replaces any `agent` field with the cell's agent before forwarding to the service.

The runner is untrusted. The daemon:

- caps each frame at 256 KiB;
- validates every frame against the schema;
- accepts events only for the turn in progress;
- ends the cell on the first violation.

The runner truncates tool output to 16 KiB and other text to 64 KiB before sending, so that a valid runner never hits the daemon's limits.

Closing the runner's stdin ends the runner and therefore the cell. The daemon does this after the idle timeout and on cancellation of the task.
