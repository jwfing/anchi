# Agent team design (version 2)

**Status: planned. Nothing in this document is implemented yet.** The current implementation is described in the [project overview](../../README.md), the [security model](../../SECURITY.md) and the [security foundation](../SECURITY_FOUNDATION.md). Where this design changes an existing boundary, the change is called out explicitly.

Positioning: **a secure, controllable agent team.** Anchi runs a team of Codex and Claude Code agents on the user's machine. Each agent runs in a disposable cell, and upstream credentials stay outside the cell.

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

Non-goals for now: remote machines, defending against privilege borrowing between agents (see [Known risks](#known-risks)).

## Architecture

```text
TUI client ──┐
(future GUI) ┴─ JSON-RPC + event stream over a Unix socket
                │
          anchi daemon (host, long-running)
          scheduler · orchestrator · task store · approval queue · agent registry
                │  Lima SSH (trusted administration)
                ▼
          secure-vm (long-running Lima VM)
          ├─ trusted services: auth, policy, existing connectors, egress proxy
          └─ per-task cells (systemd-nspawn, created on demand, destroyed at task end)
               runtime SDK (Codex / Claude Code) + Anchi MCP server
```

### Daemon

The daemon is the control plane. Clients only render state and forward user input, so the UI can be closed while scheduled tasks keep running. Setup, OAuth loopback, vault unlock and VM administration move from `desktop/src/main` into the daemon. The protocol is client-agnostic so a GUI client can be added later without changing the daemon.

The implementation starts from the `my-bot` daemon (scheduler, team, permissions, notifications) and its Ink TUI.

### VM and cells

- The VM is **long-running**. Trusted services stay up, and the vault is unlocked once per VM boot, as it is today.
- Each task gets a **new nspawn cell** that is destroyed when the task ends. Cell images are layered: one shared base image plus a per-agent overlay, with a discarded tmpfs layer on top (`--volatile=overlay`). Starting a task never copies a rootfs. The PoC measured about 30 ms to start and exit such a cell; `--ephemeral` full copies on ext4 took 1.6–9.2 s.
- Each cell has a **distinct identity**: its own proxy socket path (for example `/run/anchi/cells/<task>/proxy.sock`), bound only into that cell. When the daemon starts a cell, it registers the mapping `socket → agent → allowed rule set` with the proxy and policy; it removes the mapping when the cell is destroyed.
- Agents can run concurrently. The daemon enforces a per-host concurrency limit.

### Runtimes

| Runtime | Phase | Model authentication |
|---|---|---|
| Codex | 1 | The cell holds a placeholder `auth.json` that carries the real account id (an identifier) and placeholder tokens. The proxy injects the access token on `chatgpt.com`, including the WebSocket model stream, and the trusted side owns refresh. Verified end to end in the PoC, including tool calls. The image must install the full `codex-package-<target>`, not the bare binary. By default Codex runs with `--sandbox danger-full-access`, and the cell is the only isolation boundary; the VM keeps Ubuntu's restriction on unprivileged user namespaces. As a per-agent option, an AppArmor profile can grant `userns` to `/usr/bin/bwrap` so Codex's `workspace-write` sandbox works inside the cell; this also lets the agent create nested user namespaces through bwrap |
| Claude Code | 2 | Subscription by default via a `claude setup-token` token. The cell holds a placeholder `CLAUDE_CODE_OAUTH_TOKEN`; the proxy substitutes the real token on requests to Anthropic hosts. API key or Bedrock remain optional alternatives. Verified in the PoC with a `setup-token` token, including tool use; Claude Code performs no local token-format check and contacts only `api.anthropic.com` (plus credential-free telemetry). |

Pi is replaced by the runtime SDKs. Connectors are exposed to both runtimes through a single **Anchi MCP server** inside the cell, which forwards to the existing connector sockets. Each connector is integrated once and both runtimes can use it.

### Skills

Skills (`SKILL.md` directories) are managed centrally, sourced from GitHub or created locally, and assigned per agent. The daemon copies the agent's assigned skills into the cell at task start. Skill content is untrusted, like any other cell content.

## Credential boundary: egress proxy

**Invariant: upstream credentials never enter the cell.** "Credential" means anything that authenticates (tokens, keys, refresh tokens). Account identifiers that clients check locally, such as the ChatGPT account id, may enter the cell. This includes model subscription tokens, GitHub tokens and AWS keys. Credentials that an API would mint for the agent are covered by the same invariant (see rule 4 below).

This is a deliberate change from the current boundary: today the cell has **no IP egress**. Under this design, cells reach the network only through a trusted proxy, which runs as its own UID inside the VM.

### Mechanism

1. The cell keeps `--private-network` (loopback only). A forwarder inside the cell listens on `127.0.0.1` and relays to the cell's proxy Unix socket, and `HTTPS_PROXY` points at it. The cell has no other route: raw TCP, UDP and DNS fail, and clients that ignore `HTTPS_PROXY` fail closed.
2. The cell image trusts an Anchi CA. The image configures `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `AWS_CA_BUNDLE` and git `http.sslCAInfo` to use it. Clients that pin certificates cannot be intercepted; they are either passed through or blocked.
3. The proxy terminates TLS and matches each request against **injection rules** (`host + method + path`). A matching request has its credential injected or replaced, then the proxy forwards it upstream over a new TLS connection.
4. Requests that match no injection rule are forwarded unchanged.
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
4. **Operation allowlist or denylist** per connector, with a reserved `mode: auto|ask` field. Phase 1 implements only `auto`.
5. **Deny credential-minting APIs**, because their responses would carry new credentials into the cell:
   - AWS: `iam:CreateAccessKey`, `sts:AssumeRole*`, `sts:GetSessionToken`, `sts:GetFederationToken`, and IAM writes in general
   - GitHub: creating deploy keys or user SSH keys, installation-token endpoints, Actions secrets

### AWS: re-signing proxy

The cell holds a placeholder access key pair, and the AWS CLI signs requests with it. The proxy strips that SigV4 signature, checks the request against the allowlist and re-signs it with the real credentials.

- **Action extraction** depends on the service protocol. For query-protocol services (IAM, STS), the action is the `Action=` body parameter. For JSON-protocol services, it is the `X-Amz-Target` header. For REST services such as S3, it is the method and path.
- **Phase 1 scope:** a per-service allowlist, with STS and IAM writes denied. S3 uploads must use `UNSIGNED-PAYLOAD`; chained `aws-chunked` signatures are not re-signed.
- SSO refresh and role assumption run on the trusted side, using credentials sourced from the host profile.
- Presigned URLs generated inside the cell carry the placeholder signature and are invalid. This is expected.
- **PoC status:** verified from a task cell with real credentials. Query (STS, EC2), JSON (CloudWatch Logs) and REST (S3 list) calls re-signed correctly. Minting calls returned an AWS-shaped `AccessDenied`. Unsigned requests (public downloads) pass through. S3 uploads with streaming checksums are untested.
- **Least privilege comes from IAM.** Agents with the AWS connector act with the full authority of the configured principal, minus the deny list. Configure a dedicated least-privilege principal for agents rather than a personal key.

### What the boundary does not cover

- **Credential isolation is not data isolation.** Unmatched traffic is forwarded, so an agent can send anything it has read to any host.
- Code running in the cell can use every operation an injection rule allows, including writes, without seeing the credential.

## Work directories

- **Default:** a persistent volume inside the VM, one per agent. Repositories are cloned there and pushed through the proxy. Dependency caches (npm, pip, Go modules) also live in the VM and are isolated per agent; they are never shared with the host or with other agents.
- **Optional host mount:** Lima mounts a single host root (for example `~/AnchiWorkspaces`) into the VM once. Each cell then bind-mounts only the subdirectories its agent is configured with. Mounting the single root once avoids restarting the VM to add new directories.
- **Host-mount risk:** a writable repository mount lets the agent plant code that later runs on the host as the user: `.git/hooks/*`, `package.json` scripts, `.envrc`, `.vscode/tasks.json`, `Makefile`. The UI must state this risk when a mount is configured. Mounts mask `.git/hooks`; the cell cannot change `core.hooksPath`.
- The existing host file broker (bounded UTF-8 text with trash recovery) remains available for document-style directory grants.

## Orchestration

- Agents never communicate directly. An agent calls an MCP tool in its cell (`delegate_task` / `send_to_agent`), and the call reaches the daemon, which starts or queues a task for the target agent.
- Internally, the daemon models tasks after A2A (`Task`, `Message`, `Artifact`). A2A is exposed externally only if remote machines are added later.
- Delegation depth and per-task budget limits apply. These limits prevent runaway loops and cost; they are not a security control.
- Triggers: manual tasks (phase 1), plus cron schedules and connector polling such as new Linear tickets (phase 2).

## Agent builder

The builder is itself an agent that runs in a cell. It produces a candidate configuration:

- system prompt, runtime and model
- skills
- connectors
- work directories
- a cell image definition

Images are built in a separate build cell with proxy egress and no injection rules. A generated configuration grants capabilities, so **nothing takes effect until the user confirms it**. Any change to the image requires confirmation again. The builder cannot change its own configuration or the configuration of other agents.

## Tasks

A task is one execution of an agent. The task store records:

- agent
- trigger and parent task
- status
- start and end time
- final result
- a summary of key steps

The current desktop activity log deliberately omits chat and approval bodies. Task history needs bodies, so the task store is a new, explicit decision: it lives on the host under the daemon's data directory, and the user can delete it.

## Client

**Phase 1 uses a TUI**, built on the `my-bot` Ink client in herdr style:

- **Left menu, upper section:** runtimes, skills, connectors and agent builder.
- **Left menu, lower section:** the agent list.
- **Main pane:** chat with an agent or with the builder.

TUI-specific requirements:

- **Escape sanitization.** All agent-originated text is stripped of control characters and ANSI/OSC sequences before rendering. This blocks clipboard access through OSC 52, spoofed links through OSC 8, and screen clearing that could fake an approval dialog.
- **Security confirmations** use full-screen modals that agent output cannot reproduce. These modals replace the current native dialogs.
- **Secret input** uses masked input that agent content cannot draw over.
- **Notifications.** The daemon notifies the user about approvals and task completion while the TUI is closed (system notification or Telegram).

The Electron desktop app is frozen. Its setup, OAuth and vault logic moves into the daemon.

## Phases

**Phase 0 (spikes, first week):**

1. CJK IME input and long-transcript rendering in the Ink TUI.
2. Claude Code running with a placeholder `CLAUDE_CODE_OAUTH_TOKEN` behind the proxy. Determine local token-format checks and every Anthropic host the CLI contacts.

**Phase 1:**

1. Daemon extraction and per-task cells.
2. Egress proxy with GitHub injection rules. This proves the credential invariant end to end.
3. Codex runtime and the Anchi MCP server.
4. Agent builder.
5. Linear connector.
6. AWS re-signing proxy.
7. Minimal task list (status, times, final result).

**Phase 2:**

- Claude Code runtime
- cron and polling triggers
- `@` delegation and orchestration
- full task list

**Not planned:** remote machines.

## Known risks

- **Privilege borrowing.** Untrusted input can travel through a delegation chain to a high-privilege agent, for example from a Linear ticket to a manager agent to a merge agent. This is accepted for now. Mitigation later: mandatory `ask` for high-risk operations regardless of origin.
- **Open egress for unmatched traffic** allows data exfiltration. See [What the boundary does not cover](#what-the-boundary-does-not-cover).
- **Claude subscription terms.** The Agent SDK documentation states that, unless previously approved, third-party developers may not offer claude.ai login or rate limits for their products. Subscription mode must be revisited before public distribution.
- **Host-mounted work directories** allow code execution on the host. See [Work directories](#work-directories).
- **Shared IPs.** Kernel egress rules cannot distinguish services that share an IP address; layer-7 decisions rest on the proxy.
