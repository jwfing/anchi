# Agent team contracts

These are the interfaces between the parts of the [agent team](AGENT_TEAM_DESIGN.md): the agent configuration, and the channels that cross a process or trust boundary. The types and zod schemas live in `anchi/packages/protocol` and `anchi/packages/core`; this document explains them.

```text
TUI ──(1) client socket──▶ daemon ──(2) limactl shell + sudo (or sudo in the guest), fixed commands──▶ guest root
                             ▲                                                     │
                             └────(3) runner stdin/stdout, through (2)──── cell runner (untrusted)
```

## Agent configuration

Agents are YAML files in `~/.anchi/agents/<id>.yaml`. The file name is the id: 1–40 lowercase letters, digits or `-`. An agent can `extend` a template in `~/.anchi/templates/`; objects merge key by key, and arrays and scalars replace.

| Field | Default | Meaning |
|---|---|---|
| `name`, `description` | id, none | Shown in the TUI |
| `runtime` | required | `codex`, `claude-code` or `hermes` |
| `execution` | none (this daemon) | `{server: saved-alias, agent: existing-node-agent}`. Plain validated ids only; `local` and `builder` are refused as remote targets. The target profile must execute locally on that node. Its runtime, prompt, image, skills, workspaces, credentials and policy apply; the coordinator's runtime field remains required by the file schema but does not select execution. The wrapper owns name, description, team delegates, triggers and `maxTasks`. |
| `model`, `effort` | runtime default | Passed to the runtime |
| `prompt` | `{mode: append, text: ''}` | `text` or `file` (relative to the declaring file). `replace` replaces the runtime's base instructions (Codex's `instructions`, Claude Code's preset system prompt); Hermes keeps its own system prompt and the text becomes its persona (`SOUL.md`) in both modes |
| `connectors` | `[]` | `github`, `aws`, `linear`, `posthog`, `sentry`, `firecrawl`, `figma`, `discord`: the proxy injects credentials only for these. `gmail`, `drive`, `notion`, `slack`, `x`, `reddit`: reached through per-cell bridge sockets at `/run/anchi/connectors/<id>/api.sock`, which name the agent to the service |
| `image` | `codex` | An image recipe id in `~/.anchi/images/`, or the built-in `codex` image |
| `network` | `proxy` | Reserved; `proxy` is the only value in phase 1 |
| `sandbox` | `cell` | `cell`: the runtime runs without its own sandbox and the cell is the boundary. `codex-workspace-write` (Codex only): Codex's own sandbox as well; needs the per-agent AppArmor opt-in |
| `delegates` | `[]` | Agents this agent may delegate tasks to; not itself |
| `accounts` | `{}` | For `gmail` and `drive` among `connectors`: the named Google account the agent uses (`{gmail: work}`); `default` otherwise. The bridge pins it per cell; the cell cannot choose another |
| `approvals` | `{}` | Per connector, `ask` holds the agent's writes for the user: in the proxy for the proxy connectors; in the policy service, as the principal `<connector>:<agent>`, for `gmail`, `drive`, `notion`, `slack`, `x`, `reddit`. For `x` and `reddit`, whose service mode defaults to `ask`, `auto` gives the agent its own `auto` rule: its posts go out without approval even while the service asks. For the other services `auto` follows the service's mode |
| `highRisk` | `{disable: []}` | `{disable: [ids]}`: high-risk operations (ids of `HIGH_RISK` in `services/egress_rules.py`, at most 30) the agent does without approval; an unknown id is an error. Adds to `highRisk.disable` of `~/.anchi/settings.yaml`. `approvals: {<connector>: ask}` still holds them |
| `triggers` | `[]` | `{schedule: '<cron>', text}` or `{poll: {type: linear-issues, team?, label?, state?} \| {type: github-issues, query}, text, every?}`; `text` may use `{title}`, `{url}`, `{id}` |
| `skills` | `[]` | Skill ids in `~/.anchi/skills/`, at most 200; together at most 8 MB and 2000 files |
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

- **Tasks:** `tasks.create`, `tasks.send` (a follow-up turn), `tasks.retry` (a failed or cancelled task: continue its session, or `fresh` for a new task with the same request), `tasks.cancel`, `tasks.list`, `tasks.get`, `tasks.events` (one page of stored events after `afterSeq`, oldest first, bounded in events and bytes so it fits a client frame; callers page with the last seq until a call returns nothing), `tasks.wait`, `tasks.scan` (credential-invariant scan of the task's live cell), and `tasks.audit` (the task's rows of the egress audit log joined with the rows the daemon saved when its cells closed, summarized; `savedOnly` when the VM could not be read: hosts and decisions, injections by rule, credentials the cell sent, refusals, held writes, bridge calls, its registration, the latest 500 requests).
- **Usage:** `usage.summary {since?, by?}` (token totals of turns since a time, by `agent`, `runtime`, `model` or `day`) and `usage.quota` (the subscription limits the egress proxy last saw, per runtime: Codex's plan and windows, Claude Code's rate-limit headers); `access.summary {since?}` (the saved audit rows of all tasks since a time, by agent and by host, with the requests where a cell sent its own credential and the latest refusals; running tasks' rows are read first).
- **Starter creation:** `agents.createPreview({agentId, runtime})` accepts only these two fields, validates the id and runtime, and returns a `BuilderProposal` without calling a model or writing files. Its YAML explicitly grants no connectors or workspaces; the default network permits public hosts and the default `maxTasks` is 3. `builder.apply` confirms it; `builder.discard` cancels it. Reserved and existing ids are refused. A starter retains its create-only guard through `builder.revise`: apply cannot overwrite a file that appeared after preview, including a concurrent create. The CLI uses `agents create <id> --runtime <runtime>`, `--preview` or explicit `--yes`; the TUI uses Getting started or **Ctrl+X, N**. No cell-runner method exposes this host administration operation.
- **Agents and builder:** `agents.list`, `agents.reload`, `agents.settings`, `agents.update`, `agents.allowHost` (adds one exact host to an agent's egress list, after the user confirms), `agents.deletePreview`, `agents.delete` (the id typed by the user confirms it), `builder.proposal`, `builder.revise`, `builder.apply`, `builder.discard`. `builder.apply` and `agents.update` with `apply` create or update agent or image files, and the TUI and the desktop app call them only after showing the change. The desktop app also confirms, in a system dialog from its main process, an `agents.update` with `apply` that adds a delegation recipient, a connector, a workspace or a high-risk exemption, or makes a workspace read-write. `agents.update` changes `name`, `description`, `runtime`, `model`, `effort`, `prompt` (`mode`, `text`), `skills`, `connectors`, `delegates`, `workspaces` and `highRisk` (`{disable: [ids]}`, which replaces the file's list; `[]` removes it; unknown or repeated ids are refused) of an agent file, keeping the rest and its comments. Each newly exempted high-risk id is a warning in the result. An empty `description`, `model` or `effort` removes the key. A file with `prompt.file` refuses prompt changes. With `apply`, it requires the digest (`base`) of the file the reviewed diff was made from. `agents.settings` returns the resolved values (`current`, with `highRisk: {disable}` and `delegates`; older daemons omit the latter, so clients keep delegation read-only), the fields inherited from a template, the read-only rest (`fixed`, with `highRiskGlobal`: the known ids `~/.anchi/settings.yaml` exempts for every agent) and the inventory (with `highRisk`: every id an agent can exempt). `fixed.delegates` remains available to older clients. Delegation lists replace inherited grants; `[]` revokes all, and unknown recipients, self-delegation, duplicate entries and lists over 50 are refused. Desktop `builder.apply` also requires native confirmation for new delegation grants. The CLI uses the same preview/base/apply protocol through `agents delegates <id>` (`--allow`, `--revoke`, `--clear`, `--preview`, `--yes`). A builder proposal has a `kind`: `create`, `replace` (a whole file for an existing agent) or `update`. An `update` comes from an `anchi-agent-patch` block, holds the patch, and is applied like `agents.update`. Every proposal holds the `base` digest of the agent's file from when it was proposed; applying any kind is refused if the file changed since (for `create`: if a file appeared), and a `create` writes create-only. Desktop `agents.delete` requires a matching typed `confirm` id, a native confirmation naming the machine and agent, and an unchanged deletion preview after confirmation. Its connection remains pinned through both preview reads and the delete call. The built-in builder cannot be deleted; partial cleanup is reported and can be retried through another preview. Proposals and settings changes are checked against what exists: missing skills, delegates or directories block, connectors not yet connected warn.
- **Setup and connectors:**
  - `setup.prepare({runtime, confirm: true, vmSize?})` accepts only those fields and runs missing environment steps in order: start/create/install the VM, initialize or unlock the vault, prepare the chosen runtime layer. Missing prerequisites, unknown VM state and guest errors stop it. It rechecks status after each step, imports available local Codex and Claude Code subscription logins when the vault is ready, never starts a task, and serializes against other prepare/run/reset operations. Progress uses `setup` notifications. The CLI is `anchi setup prepare [--runtime <runtime>] [--yes] [--cpus N --memory N]`; the TUI uses recommended resources after a trusted confirmation. Optional `setup.status` fields `quickSetup`, `preparing`, `preparedRuntimes` and `hostLogins` advertise the flow, an operation still running after a client disconnects, ready layers and host login metadata. `hostLogins` contains `codex` and `claude`, each with `installed` and `state` (`ready`, `missing`, `expired`, `unavailable`, `disabled`), never credentials. Clients prefer an already-connected runtime, then detected Codex, then detected Claude; runtime selection is skipped when a usable login is known. `ClaudeAccountStatus.expiresAt` is the host login expiry in milliseconds, null/absent for manual credentials;
  - Local login synchronization runs at daemon startup, after setup, on credential file changes and every five minutes; it waits for an installed, current guest and unlocked vault. `codexAutoImport: false` / `claudeAutoImport: false` in `settings.yaml` disable each source. Only newer access tokens are copied; a different stored Codex account and manual Claude credentials are preserved.
  - `setup.status` (with `googleClientSource`: `user`, `builtin` or null; `vmSize`: `{default, host, current?}` as `{cpus, memoryGiB}`, half of this computer, all of it, and the VM's own size as Lima reports it; `appVersion`, `guestVersion` from `anchi-cell version` (null when the VM is not running or the guest predates the command) and `guestOutdated`, true once the base image is built and the two versions differ; and `error` when the VM runs but a guest command failed, in which case the guest-side fields are unknown rather than false; `host.missing` also names a Lima older than the template's `minimumLimaVersion`) and `setup.importCodex`;
  - `setup.resetPreview` and `setup.reset` (`confirm: "reset"`, refused while tasks run) delete the VM with `limactl delete --force anchi-vm`, output as `reset` notifications; deleting the vault key and Anchi home (`anchi setup reset --all`) happens in the CLI after the daemon has stopped;
  - `services.redditClient({clientId, developerUsername})` stores an installed public Reddit app Client ID (1–256 base64url characters) and developer username (3–20 ASCII letters, digits, `_` or `-`). Replacement is refused while connected or revocation is pending. `services.redditLogin({})` uses the fixed callback `http://127.0.0.1:48174/callback`; both methods refuse unknown fields. Completion emits `oauth` with `id: reddit`; `setup.status.redditClient` reports configuration and service status includes `revocationPending`. `services.disconnect({id: reddit})` removes local tokens and attempts remote revocation. There is one account and no account parameter;
  - `services.xClient({clientId})` stores a native public X app Client ID (1–256 base64url characters); replacement is refused while tokens or pending revocation exist. `services.xLogin({})` opens PKCE sign-in using `http://127.0.0.1:48173/callback`; unknown fields are refused. Completion uses the `oauth` notification with `id: x`. `setup.status.xClient` reports configuration and the X service status reports `revocationPending`. `services.disconnect({id: x})` removes local tokens and attempts remote revocation. X has one account and accepts no account parameter;
  - `services.googleLogin` and `services.disconnect` take an optional Google `account`; `services.removeGoogleClient` drops the user's client;
  - `setup.run` runs one setup step at a time: `vm-start`, `install`, `vault-init` or `vault-unlock`. Each is a fixed host command from the checkout (`limactl start`, `scripts/up.sh` then `scripts/install-anchi.sh` then the base image build, `scripts/vault.py`). The vault key is read by `vault.py`, not by the daemon. A daemon inside the guest has no `vm-start` or `workspaces` step and refuses `setup.reset`; its `install` runs the same scripts on its own machine. `install` takes an optional `vmSize` `{cpus, memoryGiB}`, whole numbers within the host (`BAD_VM_SIZE` otherwise), passed to `scripts/up.sh` as `ANCHI_VM_CPUS` and `ANCHI_VM_MEMORY_GIB`; it sizes a VM the step creates, and an existing VM keeps its size. Output lines arrive as `setup` notifications;
  - `connectors.importGh` imports the token of the host `gh` CLI; `connectors.awsProfile` imports the temporary credentials of a host AWS profile and keeps them refreshed (the profile name is kept in `~/.anchi/data/connectors.json`, no secret);
  - `connectors.set` carries a secret. The daemon writes it to the guest administration command's stdin and never stores or logs it. It then verifies the connector, records the account it reports, and removes a credential the service refuses.
- **Phase 2:**
  - `tasks.search` (agent, status, words, time), `tasks.tree`, `tasks.delete`;
  - `approvals.list`, `approvals.decide` (called only after the approval dialog or the Approvals view showed the write). A policy approval carries the full frozen parameters in `summary` (at most 65,536 UTF-8 bytes; oversize is refused, not truncated); the TUI labels a preview and offers a wrapped, scrollable full dialog;
  - `triggers.list`;
  - `skills.list`, `skills.add` (local directory or GitHub URL; a collection without a top-level `SKILL.md` adds each skill and returns `{added, skipped}`), `skills.remove`, `skills.checkUpdate` (what the latest commit of the URL changes, nothing written), `skills.update` (installs the commit the user reviewed);
  - `setup.importClaude`, `setup.importHermes` (`baseUrl`, `apiKey`, `model`; the key on stdin to `hermes_admin.py`); `services.setToken`, `services.disconnect`, `services.setMode` (`auto` or `ask` for every agent; X and Reddit default to `ask`, and `auto` lets agents publish under the user's account without approval; the TUI confirms that first and the CLI prints a warning), `services.googleClient`, `services.googleLogin`.
- **Notifications:** `event` (runtime event of a task), `tasks`, `agents`, `proposal`, `setup` (a line of setup output), `approvals`, `oauth`, `tasksDeleted`.

Every string in a runtime event is agent-originated. Clients must strip control characters and escape sequences before display.

## Desktop ⇄ multiple daemons

The desktop main process holds an independent connection for `local` and each saved remote
target. The preload's `call(server, method, params)` and `onNotify(server, name, params)`
include the canonical target; `connections` / `onConnections` expose per-machine status.
`setServer` selects a machine without closing any others. `connectServer(target, connected)`
connects or disconnects one registered machine. These are desktop IPC operations; daemon RPCs
and the single-server TUI/CLI contract are unchanged.

Renderer models are keyed first by machine, then by daemon-local agent, task, approval or
proposal id. Every view receives a call function bound to its machine. Configuration forms
remount on a machine or connection-state change. Main-process confirmations name and pin the
machine's connection; a disconnected, removed or replaced connection refuses the final write.
Folder picking remains local-only; Google client imports target the originally selected daemon.
Listing an agent does not create a coordinator member or change its delegation grants.

## Coordinator ⇄ execution daemon

This uses the existing owner-authenticated SSH/instabox bridge, with the coordinator as client.
The bounded schemas are in `protocol/src/team.ts`. No execution RPC is exposed as a cell tool
or through the desktop renderer. Public `team.nodes` lists aliases on the coordinator;
`team.preview {agentId, execution}` reads the selected profile and creates a reviewable,
create-only builder proposal. The CLI exposes `team nodes` and `team add`; the desktop builder
uses the same preview/apply flow. TUI builder proposals accept `execution` and settings show
it read-only. `AgentSummary.execution`, `TaskRow.execution` and `AgentSettings.fixed.execution`
identify the location. `Inventory.servers` supplies the builder's saved aliases.

| RPC | Input and result |
|---|---|
| `team.describe` | `{agent}` → stable 128-bit node id, agent id, name, description, runtime, delegates, connectors and skills; refuses the builder or another remote wrapper |
| `team.run` | `{origin: {coordinator, task, agent, chain}, agent, turn, text}` → `null`. Coordinator UUID + source task id + monotonic turn deduplicate dispatch, with a digest to refuse different payloads for the same turn. A job maps to one node task across follow-ups. |
| `team.poll` | `{coordinator, task, afterSeq}` → task state/result/runtime, an ordered bounded event page, pending team calls, complete pending approval actions for this job only |
| `team.reply` | `{coordinator, task, request, outcome}` → `null`; outcome is `{kind: 'result', value}` or `{kind: 'error', message}`. A request belongs to the current job turn; conflicting duplicate replies are refused. |
| `team.cancel` | `{coordinator, task, turn}` → `null`; durable cancellation through that turn, including before dispatch. Later explicit turns have new numbers. |
| `team.approve` | `{coordinator, task, id, allow}` → `null`; only an approval of the job's node task can be decided. The node retains and enforces the policy digest. |

Imported tasks have `TaskRow.teamOrigin`. Their base/delegation tools are relayed; connector
approval notifications remain node-local. The coordinator reconstructs task identity from
its persisted job, validates the tool schema and current member grant, and enforces the
normal depth/children/tree-turn/cycle/child-ownership checks. The node independently validates
its profile's grant. `anchi_whoami` returns the logical member and source task id. Discovery
returns the intersection of grants. No remote call can choose its parent, transport or policy.

SQLite `team_state` holds the node id, pinned outbound jobs and event cursors, worker job maps,
dispatch receipts, pending tool calls and tool outcomes. Delegate/send effects and their
receipts commit in the same transaction, so a reconnect or coordinator restart cannot repeat
the mutation. Job state stores pending cancellation. Worker session ids never become source
resume ids. On restart, the coordinator resumes active outbound jobs; a worker restart fails
interrupted cells as before. Task deletion removes content-bearing team records on that
daemon; minimal worker receipts remain to prevent delayed replay. Polling delivers stored
events, not token deltas, and reports retention gaps. Quota and raw egress audit remain local.

## (2) Daemon ⇄ guest administration

The daemon runs only fixed commands: `limactl shell anchi-vm -- sudo <command>`, or `sudo -n <command>` when it runs inside the guest on a [remote server](../REMOTE_SERVER.md) (`ANCHI_GUEST=local`). The client reaches a remote daemon's socket through `anchi-bridge` over SSH; the protocol is the same. Secrets travel on stdin only, never in arguments. Every command prints one JSON object, or `{"error": CODE}` with a non-zero exit.

| Command | Purpose |
|---|---|
| `anchi-cell start TASK AGENT IMAGE HASH CONNECTORS SANDBOX RUNTIME ASK WORKSPACES EGRESS ACCOUNTS HIGH_RISK AUTO` | Start a task cell and run the cell runner in it. Stdin and stdout are channel (3). Blocks until the cell exits, then releases its overlay, sockets and proxy registration |
| `anchi-cell approvals watch` | Streams the proxy's queue of held writes as JSON lines, until it ends; also `credential` lines when a cell sends a credential that is not a placeholder (task, agent, method, host, path; once per host and cell), and `notice` lines for a task's transcript (a host refused by the egress list, a refused streamed push) |
| `anchi-cell approvals decide ID allow\|deny` | Answers a held write |
| `anchi-cell poll` | Runs a polling trigger's fixed read-only query (spec on stdin) in the egress service; prints the items |
| `anchi-cell skills set AGENT` | Replaces the agent's skill bundle (`{files: {path: base64}}` on stdin) |
| `anchi-cell purge-agent AGENT` | Removes a deleted agent's home, skills bundle and `<service>:AGENT` policy rules. Refused while the agent has a cell or a mount point exists under its home; removal does not cross file systems |
| `anchi-cell stop TASK` | Stop a cell and release its overlay, sockets and proxy registration |
| `anchi-cell list` | Running cells, as JSON; an image build under way is listed with `kind: build` and agent `image-builder` |
| `anchi-cell reap [TASK...]` | Stop every cell not named (an image build still running is kept), and unmount stale overlays |
| `anchi-cell scan TASK` | Credential-invariant scan of a running cell: environment and command line of every process (nested pid namespaces included) and the files of its writable layers changed since it started; `partial: true` with `stopped_at` (`files`, `bytes` or `time`) when a limit stopped it |
| `anchi-cell verify CONNECTOR` | Has the egress proxy call the connector's identity endpoint (GitHub `/user`, Linear `viewer`, AWS `GetCallerIdentity`, PostHog `/api/users/@me/` on the US then the EU cloud, Sentry `/api/0/organizations/`, Firecrawl `/v2/team/credit-usage`, Figma `/v1/me`, Discord `/api/v10/users/@me`) with the stored credential. Prints the account, or `CREDENTIAL_REJECTED` |
| `anchi-cell audit TASK` | The task's rows of the egress audit log and its rotated file, the latest 2000, as JSON with their total |
| `anchi-cell quota` | The latest subscription limits the egress proxy saw in runtime responses, as JSON |
| `anchi-cell version` | The Anchi version that installed the guest components and when (`/opt/secure-vm/installed.json`; `unknown` when it was not recorded) |
| `anchi-cell egress-settings` | The user's settings for the egress proxy, on stdin: `{high_risk_disabled: [ids], approval_timeout_s?: 60–43200}`; the proxy validates them (`BAD_SETTINGS`) and keeps them across restarts |
| `anchi-cell exec TASK -- COMMAND...` | Run a command as the agent user in a running cell, for live checks |
| `anchi-image status ID HASH` | Whether a built layer exists for this recipe hash (and the current base) |
| `anchi-image build ID HASH` | Reuse a completed layer, install its pinned release archive when bundled, or build locally without a manifest. `codex base` prepares the base; `runtime-<runtime> runtime` prepares one runtime. Recipe layers take JSON on stdin and always build locally. A guest-wide lock serializes builds/downloads. Prints metadata and the build log path |
| `anchi-image list` / `anchi-image remove ID` | Image layers and their metadata |

| `python3 /opt/secure-vm/services/admin.py import-token\|import-aws\|disconnect\|status CONNECTOR` | Connector credentials into and out of the vault |
| `python3 /opt/secure-vm/services/admin.py import-client\|begin\|complete\|disconnect\|status x` | X native client and PKCE administration: stdin `{client_id}`, `{redirect_uri}` or `{code,state}` for the first three actions. Tokens never appear in output. `connector_admin.py x disconnect` also refreshes the provider network rules |
| `python3 /opt/secure-vm/services/codex_admin.py import-token\|status` | Codex access token and account id into the vault; status without secrets |
| `python3 /opt/secure-vm/services/claude_admin.py import-token\|status\|disable` | Claude Code token or API key into the vault; stdin `{token, expires_at?}`. A host login has finite future `expires_at` in seconds; API keys with an expiry and all refresh tokens are refused. `status` includes only `configured`, `kind`, `imported_at`, `expires_at` |
| `python3 /opt/secure-vm/services/hermes_admin.py import\|status\|disable` | Hermes's OpenAI-compatible endpoint (`{base_url, api_key, model}` on stdin) into the vault; status and disable without the key |
| `python3 /opt/secure-vm/services/admin.py import-client\|remove-client` | The user's Google OAuth client (stdin), or its removal so the built-in client applies; refused while Google accounts are connected |
| `python3 /opt/secure-vm/services/admin.py begin\|complete\|cancel\|disconnect gmail\|drive [ACCOUNT]` | Google sign-in of one named account (`default` when omitted; the code arrives on stdin; tokens stay in the VM). Refreshes the provider allowlists afterwards |
| `python3 /opt/secure-vm/services/connector_admin.py ID probe\|disconnect [ACCOUNT]` | Service connector account label, or disconnect and revoke; `ACCOUNT` for gmail and drive |
| `python3 /opt/secure-vm/services/policy_admin.py show\|approve\|deny\|mode\|clear\|rules` | Connector-service requests held by policy; modes per service (`notion`) and per agent (`notion:writer`) |
| `python3 /opt/secure-vm/services/vault_admin.py status` | Whether the vault is unlocked |

Release layers are described by `/opt/secure-vm/anchi/prebuilt.json`, copied from the app bundle
alongside the build scripts. The manifest pins the release version, architecture, a compatibility
digest of the pins and root/layer recipes, archive sizes and SHA-256 hashes. Archives come only
from the fixed Anchi GitHub release URL. Missing manifests use local builds; invalid manifests,
failed downloads and verification errors fail preparation. The extractor validates the full
archive index before writing, bounds compressed and expanded sizes and entry count, prevents
traversal through links, maps cell-relative owners, and allows only overlay whiteouts and opaque
directory xattrs. Installation stages a complete layer before renaming it into place.
`anchi-cell list` includes an active `build-image-install` entry while the build lock is held,
including during downloads, so installation and live checks refuse to interrupt them.

`TASK`, `AGENT` and `IMAGE` match `^[a-z0-9][a-z0-9-]{0,39}$`. `HASH` is `base`, `runtime` (a runtime layer: `runtime-codex`, `runtime-claude-code`, `runtime-hermes`) or the recipe's 16-hex content hash. A cell's overlay stacks its runtime's layer over its recipe's layer over the base; the base and runtime layers are named by the hash of their build script and the `guest/cell.env` pins it reads, so a change builds them again. `CONNECTORS` is a comma-separated subset of the proxy connectors `github,aws,linear,posthog,sentry,firecrawl,figma,discord` and the connector services `gmail,drive,notion,slack,x,reddit`, or `-` for none. `SANDBOX` is `cell` or `codex-workspace-write`. `RUNTIME` is `codex`, `claude-code` or `hermes`; a Hermes cell is refused (`HERMES_NOT_CONFIGURED`) until its endpoint is stored. `ASK` is the subset of the connectors whose writes are held, or `-`; for connector services the cell manager sets or clears the agent's policy rule at start. `WORKSPACES` is base64url JSON `[{name, path, mode}]` or `-`; the cell manager checks again that each path stays under `/mnt/anchi-host` without symlinks or `..`. `EGRESS` is base64url JSON host patterns, or `-` for open egress. `ACCOUNTS` names the agent's Google account per service (`gmail=work,drive=personal`), or `-`. `HIGH_RISK` is the comma-separated ids of the high-risk entries that do not wait for approval in this cell (`highRisk.disable` of the settings and the agent file, at most 30 ids of `[a-z0-9-]{1,40}`; the proxy checks them), or `-`. `AUTO` is `x`, `reddit` or both: the services among the connectors, and not in `ASK`, whose writes the agent's approvals make automatic; the cell manager gives the agent an `auto` policy rule for them at start (`BAD_APPROVALS` otherwise). The daemon sends `HIGH_RISK` and `AUTO` only when needed, so an older guest still starts other cells and refuses (`USAGE`) one it would treat as asking.

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


## Peer daemons

`peers.configure`, `peers.identity`, `peers.directory`, `peers.admit` and `peers.remove` are owner
socket RPCs. They are never callable from task cells or the peer listener. The desktop validates
their parameters and requires native confirmation for listener configuration, enrollment and
revocation; the CLI provides `team network`, `team peers`, `team join` and `team revoke`.

`peers.ts` defines the strict, bounded wire schemas. `delegateRefSchema` permits a local agent id
or `<node32hex>/<agent-id>/<generation16hex>`. Agent `delegates`, builder inventory and all
editors use that union. `Inventory.peerAgents` supplies display labels and liveness; global ids
remain the authority. `AgentSummary.node` identifies a direct owner, while `AgentSummary.peer`
identifies a discovered entry. `agents.list` includes both; `tasks.create` accepts either id.

The peer listener uses TLS 1.3 with self-signed P-256 certificates and pins the enrolled public
key in both directions before reading application frames. Keys are generated on first setup
with OpenSSL, under `~/.anchi/peers/identity/` (directory 0700, private key 0600). The persistent SQLite
node id and certificate identify one daemon. Certificates expire after ten years; there is no
automatic certificate rotation. Do not clone a live daemon's database and private identity.

`peer.sync` exchanges bounded, owner-signed whole catalog snapshots and revocations. Each owner
increments its revision on a local catalog change. Receivers accept only newer valid snapshots
for the pinned identity. Revocations dominate snapshots and are retained. A trusted member can
introduce another signed member; this is an owner trust domain, not Byzantine consensus.
The initial implementation exchanges rotating batches of signed snapshots every three seconds,
up to 32 nodes and 200 agents per node. Each signed catalog is bounded to 2 MB; publication
truncates descriptions to 500 characters and skill names to the first 50 entries. Liveness is a current authenticated link, not a guarantee the runtime is ready.

Only `peer.sync`, `task.run`, `task.poll`, `task.cancel` and `task.approve` are accepted on the
peer socket. `task.run` carries a stable request id, root and parent task refs, target generation,
global lineage, disjoint turn budget, turn number and text. The authenticated caller must own
the immediate parent/penultimate lineage entry. An owner-submitted root has a null parent,
a one-agent lineage, and the request/root id on its submitting daemon. Cells cannot choose
origin, lineage, budget, endpoints or credentials.

Each parent stores a mirror task and outbox in SQLite; each recipient atomically stores its
execution task and per-turn digest receipt before the queued cell can run. Retries of dispatch
are idempotent. Reusing a request with changed content, changing the target/ancestry/budget,
skipping a turn, selecting a stale generation or supplying a cyclic lineage is refused.
`TaskRow.peer` distinguishes `execution` from `mirror`; `observed` descendant mirrors are read-only.
Runtime session identifiers do not cross the peer transport. Results and events are bounded
and paginated. Mirror event writes and cursor advancement share a transaction. Descendant rows
are read-only snapshots; the full transcript and raw audit remain on each executor.

`task.cancel` persists a per-turn tombstone even before dispatch. Pending cancellations retry
until the peer answers. `task.approve` first resolves the authenticated caller's job and checks
the approval belongs to its subtree; each hop repeats the check and the executor rechecks the
policy digest. Revocation neither rolls back external writes nor proves running cells stopped.

A tree starts with 60 integer turn credits. Each executing turn consumes one; each child is
allocated a disjoint range of up to ten (half of the parent's remaining credits, at least one).
This bounds total work without a coordinator even through partitions. Reservations are not
reclaimed. Both local children and remote children inherit lineage and ranges. Legacy
`execution:` wrappers cannot be mixed into a peer-budgeted branch.
