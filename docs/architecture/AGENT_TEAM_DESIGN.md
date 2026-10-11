# Agent team design (version 2)

**Status: phases 1 and 2 and most of phase 3 are implemented**; Linux workspaces and part of the live acceptance remain. See the [phase 1](AGENT_TEAM_PHASE1_PLAN.md#status), [phase 2](AGENT_TEAM_PHASE2_PLAN.md#status) and [phase 3](AGENT_TEAM_PHASE3_PLAN.md#status) plans for what differs from this design, and the [backlog](BACKLOG.md) for what is recorded but not planned. The [agent team guide](../AGENT_TEAM.md), the [contracts](AGENT_TEAM_CONTRACTS.md) and the [security model](../../SECURITY.md) describe the implementation.

Positioning: **a secured agent team.** Anchi runs a team of Codex and Claude Code agents on the user's machine. Each task runs in a disposable cell, upstream credentials stay outside the cell, each agent gets only the connectors, hosts, directories, skills and delegates it is configured with, and writes that matter wait for the user.

## Goals

1. Build agents on a locally available **runtime**: Codex or Claude Code, driven through their SDKs. An agent is defined by:
   - runtime and model (the model list depends on the runtime)
   - system prompt
   - skills
   - work directory
   - allowed connectors
   - cell image
2. Assign tasks to agents through chat. Agents can delegate to each other with `@`, routed by the orchestrator.
3. Anchi manages connectors centrally. Agents never receive upstream credentials; a trusted proxy injects or signs them.
4. Agents consume no resources when idle. A task starts a fresh cell, and the cell is destroyed when the task ends.
5. An agent builder generates agent configurations, including the system prompt and cell image, through chat.

Non-goals: remote machines; data isolation (an agent can send what it reads to the hosts it may reach). Privilege borrowing between agents is narrowed, not prevented (see [Known risks](#known-risks)).

## Architecture

```text
TUI client ──┐
(future GUI) ┴─ JSON-RPC + event stream over a Unix socket
                │
          anchi daemon (host, long-running)
          scheduler · orchestrator · task store · approval queue · agent registry
                │  Lima SSH (trusted administration)
                ▼
          anchi-vm (long-running Lima VM)
          ├─ trusted services: auth, policy, existing connectors, egress proxy
          └─ per-task cells (systemd-nspawn, created on demand, destroyed at task end)
               runtime SDK (Codex / Claude Code) + Anchi MCP server
```

### Daemon

The daemon is the control plane. Clients only render state and forward user input, so the UI can be closed while scheduled tasks keep running. Setup, OAuth loopback, vault unlock and VM administration, formerly in the Electron app, live in the daemon. The protocol is client-agnostic so a GUI client can be added later without changing the daemon.

The implementation ports parts of the `my-bot` daemon (queue, scheduler, notifications) and its Ink TUI, refactored to the boundaries below; see the [phase 1 plan](AGENT_TEAM_PHASE1_PLAN.md#porting-my-bot).

### VM and cells

- The VM is **long-running**. Trusted services stay up, and the vault is unlocked once per VM boot, as it is today.
- Each task gets a **new nspawn cell** that is destroyed when the task ends. Cell images are layered: one shared base image plus a per-agent overlay, with a discarded tmpfs layer on top (`--volatile=overlay`). Starting a task never copies a rootfs. The PoC measured about 30 ms to start and exit such a cell; `--ephemeral` full copies on ext4 took 1.6–9.2 s.
- Each cell has a **distinct identity**: its own proxy socket (and a bridge socket per connector service), in a directory bound only into that cell at `/run/anchi`. When a cell starts, the cell manager registers it with the proxy: its task, agent, connectors, egress list, approvals and origin; the registration goes when the cell is destroyed.
- Before a cell is destroyed, the daemon scans it for real credential values.
- Agents can run concurrently. The daemon enforces a per-host concurrency limit.

### Runtimes

| Runtime | Phase | Model authentication |
|---|---|---|
| Codex | 1 | The cell holds a placeholder `auth.json` that carries the real account id (an identifier) and placeholder tokens. The proxy injects the access token on `chatgpt.com`, including the WebSocket model stream. The refresh token stays with the Codex CLI on the host; the daemon re-imports the access token when the host's login refreshes. Verified end to end in the PoC, including tool calls. The image must install the full `codex-package-<target>`, not the bare binary. By default Codex runs with `--sandbox danger-full-access`, and the cell is the only isolation boundary; the VM keeps Ubuntu's restriction on unprivileged user namespaces. As a per-agent option, an AppArmor profile can grant `userns` to `/usr/bin/bwrap` so Codex's `workspace-write` sandbox works inside the cell; this also lets the agent create nested user namespaces through bwrap |
| Claude Code | 2 | Subscription by default via a `claude setup-token` token. The cell holds a placeholder `CLAUDE_CODE_OAUTH_TOKEN`; the proxy substitutes the real token on requests to Anthropic hosts. API key or Bedrock remain optional alternatives. Verified in the PoC with a `setup-token` token, including tool use; Claude Code performs no local token-format check and contacts only `api.anthropic.com` (plus credential-free telemetry). |

Pi is replaced by the runtime SDKs. Connectors are exposed to both runtimes through a single **Anchi MCP server** inside the cell, which forwards to the existing connector services through a per-cell bridge that names the agent. Each connector is integrated once and both runtimes can use it.

### Skills

Skills (`SKILL.md` directories) are managed centrally, sourced from GitHub or created locally, and assigned per agent. The daemon copies the agent's assigned skills into the cell at task start. Skill content is untrusted, like any other cell content.

## Credential boundary: egress proxy

**Invariant: upstream credentials never enter the cell.** "Credential" means anything that authenticates (tokens, keys, refresh tokens). Account identifiers that clients check locally, such as the ChatGPT account id, may enter the cell. This includes model subscription tokens, GitHub tokens and AWS keys. Credentials that an API would mint for the agent are covered by the same invariant (see rule 4 below).

This is a deliberate change from the current boundary: today the cell has **no IP egress**. Under this design, cells reach the network only through a trusted proxy, which runs as its own UID inside the VM.

### Mechanism

1. The cell keeps `--private-network` (loopback only). A forwarder inside the cell listens on `127.0.0.1` and relays to the cell's proxy Unix socket, and `HTTPS_PROXY` points at it. The cell has no other route: raw TCP, UDP and DNS fail, and clients that ignore `HTTPS_PROXY` fail closed.
2. The cell image trusts an Anchi CA. The image configures `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `AWS_CA_BUNDLE` and git `http.sslCAInfo` to use it. Clients that pin certificates cannot be intercepted; they are either passed through or blocked.
3. The proxy terminates TLS and matches each request against **injection rules** (`host + method + path`). A matching request has its credential injected or replaced, then the proxy forwards it upstream over a new TLS connection.
4. Requests that match no injection rule are forwarded unchanged: to any public host, or, when the agent has an `egress` list, only to those hosts and the ones its runtime and connectors need.
5. The cell holds **placeholder credentials** (for example `GH_TOKEN=anchi-placeholder`), because tools such as `gh` and `aws` refuse to run without one. The proxy replaces the placeholder.
6. git uses HTTPS only: the cell image sets `url."https://github.com/".insteadOf git@github.com:`.

### Destination filtering

Passthrough must not turn the proxy into a path to private networks. The PoC showed the proxy reaching the VM's sshd and the Lima host gateway on the cell's behalf. The proxy therefore:

- refuses every destination whose resolved address is not public (loopback, RFC 1918, link-local, CGNAT, ULA);
- connects to the exact address it checked, which closes DNS rebinding;
- runs under its own UID with an nftables rule that rejects private ranges, as a kernel-level backstop.

### Rules every injection rule must satisfy

1. **Per-agent scope.** A rule applies only to cells whose agent is configured with that connector. An agent without the connector gets no injection.
2. **No redirect following** with injected credentials. An injected request is never forwarded to a different host.
3. **Runtime APIs: replace only.** For model runtimes (Anthropic, OpenAI), the proxy replaces a placeholder the client sent and never adds a credential to a request that carried none. Connector rules such as git smart HTTP may inject unconditionally.
4. **Operation allowlist or denylist** per connector. Writes are held for the user when the agent's `approvals` say `ask`, and high-risk operations (merges, deletions, pushes to the default branch, access changes) are held for every agent.
5. **Deny credential-minting APIs**, because their responses would carry new credentials into the cell:
   - AWS: `iam:CreateAccessKey`, `sts:AssumeRole*`, `sts:GetSessionToken`, `sts:GetFederationToken`, and IAM writes in general
   - GitHub: creating deploy keys or user SSH keys, installation-token endpoints, Actions secrets

### AWS: re-signing proxy

The cell holds a placeholder access key pair, and the AWS CLI signs requests with it. The proxy strips that SigV4 signature, checks the request against the allowlist and re-signs it with the real credentials.

- **Action extraction** depends on the service protocol. For query-protocol services (IAM, STS), the action is the `Action=` body parameter. For JSON-protocol services, it is the `X-Amz-Target` header. For REST services such as S3, it is the method and path.
- **Scope:** a per-service allowlist, with STS and IAM writes denied. S3 uploads are re-signed in every form: `UNSIGNED-PAYLOAD`, `aws-chunked` with unsigned chunks and trailers (as the AWS CLI sends them), and signed chunks, whose signatures are recomputed while streaming.
- SSO refresh and role assumption run on the trusted side, using credentials sourced from the host profile.
- Presigned URLs generated inside the cell carry the placeholder signature and are invalid. This is expected.
- **PoC status:** verified from a task cell with real credentials. Query (STS, EC2), JSON (CloudWatch Logs) and REST (S3 list) calls re-signed correctly. Minting calls returned an AWS-shaped `AccessDenied`. Unsigned requests (public downloads) pass through. `aws-chunked` re-signing is tested against the S3 reference's worked examples; a live upload is part of the remaining acceptance.
- **Least privilege comes from IAM.** Agents with the AWS connector act with the full authority of the configured principal, minus the deny list. Configure a dedicated least-privilege principal for agents rather than a personal key.

### What the boundary does not cover

- **Credential isolation is not data isolation.** Unmatched traffic is forwarded, so an agent can send anything it has read to any host it may reach; an `egress` list narrows which hosts, and an allowed host can still receive data.
- Code running in the cell can use every operation an injection rule allows, including writes, without seeing the credential.

## Work directories

- **Default:** a persistent home inside the VM, one per agent (`/var/lib/anchi/agents/<id>/home`, mounted at `/home/agent`). Repositories are cloned there and pushed through the proxy. Dependency caches (npm, pip, Go modules) also live there, isolated per agent and never shared with the host or other agents.
- **Directories of the host (workspaces, macOS):** Lima mounts one host root, `~/AnchiWorkspaces`, into the VM once; each cell bind-mounts only the subdirectories its agent lists, read-only unless `rw`. See [Host directories](HOST_DIRECTORIES_PLAN.md).
- **Host-mount risk:** a writable directory lets the agent leave code that later runs on the host as the user. Cells mount git hooks, config and info, `.gitattributes`, `.envrc`, `.vscode/` and `.idea/` read-only, and the daemon audits each turn for new hooks, command-running git configuration, outside symlinks, new executables and editor configuration. Files run by design (`package.json` scripts, `Makefile`) remain the user's to review.
- Deleting an agent removes its VM home but never workspace files: the binds exist only in a cell's own mount namespace.

## Orchestration

- Agents never communicate directly. An agent calls an Anchi tool in its cell (`anchi_delegate_task`, `anchi_send_to_task`, `anchi_task_status`, `anchi_list_tasks`), and the call reaches the daemon, which checks the agent's `delegates` and starts or queues a task for the target agent.
- Internally, the daemon models tasks after A2A (`Task`, `Message`, `Artifact`). A2A is exposed externally only if remote machines are added later.
- Delegation depth and per-task budget limits apply. These limits prevent runaway loops and cost; they are not a security control.
- Triggers: manual tasks, cron schedules and polls of Linear issues or GitHub issue searches. Polls run fixed read-only queries on the trusted side; each task records its origin (`user`, `schedule`, `poll:<item>`, or the delegation chain), which approval dialogs show.

## Agent builder

The builder is itself an agent that runs in a cell. It produces a candidate configuration:

- system prompt, runtime and model
- skills
- connectors
- work directories
- a cell image definition

Images are built in a separate build cell with proxy egress and no injection rules. A generated configuration grants capabilities, so **nothing takes effect until the user confirms it**. Any change to the image requires confirmation again. The builder cannot change its own configuration or the configuration of other agents.

Each builder turn starts with an inventory of what exists (installed skills, connectors and whether they are connected, directories under the workspace root, agents, images); proposals are checked against it, and missing references block them. The user can adjust a proposal's skills, connectors and workspaces in the same settings panel used for existing agents, which changes only those fields of an agent file, after showing the diff. Deleting an agent removes its file, its tasks (with what they delegated), its place in other agents' `delegates`, and its home, skills and policy rules in the VM.

## Tasks

A task is one execution of an agent. The task store records:

- agent
- trigger and parent task
- status
- start and end time
- final result
- a summary of key steps

Task history needs message bodies, so the task store is an explicit decision: it lives on the host under the daemon's data directory, finished tasks are deleted after a retention period, and the user can delete any task. A failed or cancelled task can run again, either continuing its session or as a new task with the same request.

## Client

The client is a TUI (Ink), with a CLI for the same operations:

- **Sidebar:** Configure (runtimes, skills, connectors), Agents (the builder and the agents) and Tasks (every task, in pages, with a filter).
- **Main pane:** chat with an agent or the builder, a task's details and transcript, or a Configure screen.
- **Keys:** every action through a leader key (Ctrl+X) and one more key, plain keys in views without text input, a command palette, and shell line editing in the input; configurable in `~/.anchi/keybindings.json`. Keyboard and mouse do the same things.

TUI-specific requirements:

- **Escape sanitization.** All agent-originated text is stripped of control characters and ANSI/OSC sequences before rendering. This blocks clipboard access through OSC 52, spoofed links through OSC 8, and screen clearing that could fake an approval dialog.
- **Security confirmations** use full-screen modals that agent output cannot reproduce. These modals replace the current native dialogs.
- **Secret input** uses masked input that agent content cannot draw over.
- **Notifications.** While no client is connected, the daemon notifies the user about writes waiting for approval and finished tasks; credential-scan findings and AWS sessions that need a new sign-in are notified always (macOS notifications, or `notify-send` on Linux).

The Electron desktop app and Pi were retired in phase 2, after their setup, OAuth and vault logic moved into the daemon.

## Phases

The phase 0 spikes are complete; see the [PoC summary](../../poc/README.md). Phase 1 is broken down in the [phase 1 implementation plan](AGENT_TEAM_PHASE1_PLAN.md).

**Phase 1:**

- daemon and TUI;
- per-task cells;
- the credential-injecting egress proxy;
- Codex runtime;
- GitHub, AWS and Linear connectors;
- agent builder;
- a minimal task list.

**Phase 2:**

- Claude Code runtime (verified in the PoC);
- cron and polling triggers;
- `@` delegation and orchestration through the Anchi MCP server;
- full task list;
- exposing the existing Gmail/Drive/Notion/Slack connectors to the new runtimes.

**Phase 3** (see the [phase 3 plan](AGENT_TEAM_PHASE3_PLAN.md)):

- credential scan before every cell is destroyed;
- high-risk operations always held, with the task's origin chain;
- per-agent egress allowlists and per-agent policy for connector services (the bridge);
- Codex login re-import; `aws-chunked` uploads; CLI parity and isolation checks in CI;
- Linux workspaces and live acceptance with real accounts (open).

**After phase 3:** directories of the host, Linux hosts, key bindings, the agent settings panel and builder inventory, deleting agents, retrying failed tasks. Open requests are in the [backlog](BACKLOG.md).

**Not planned:** remote machines.

## Known risks

- **Privilege borrowing.** Untrusted input can travel through a delegation chain to a high-privilege agent, for example from a Linear ticket to a manager agent to a merge agent. High-risk operations are held for every agent and origin, and the dialog shows the chain; other writes are held only where `approvals` ask. The high-risk list is a set of patterns, so an equivalent operation through another endpoint is not covered.
- **Open egress for unmatched traffic** allows data exfiltration unless an agent has an `egress` list, and even then to the listed hosts. See [What the boundary does not cover](#what-the-boundary-does-not-cover).
- **Claude subscription terms.** The Agent SDK documentation states that, unless previously approved, third-party developers may not offer claude.ai login or rate limits for their products. Subscription mode must be revisited before public distribution.
- **Writable host directories** allow code to reach the host through files run by design. See [Work directories](#work-directories).
- **Approval fatigue.** Too many held writes train the user to approve without reading; the high-risk list stays short, and `approvals` are per agent and connector.
- **Shared IPs.** Kernel egress rules cannot distinguish services that share an IP address; layer-7 decisions rest on the proxy.
