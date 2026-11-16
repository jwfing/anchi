# Host placement: Anchi without a VM

**Status: spike done on macOS (2026-11-15), P1 to P4 implemented (2026-11-15; the user guide is [docs/HOST_PLACEMENT.md](../HOST_PLACEMENT.md)), then the Python side replaced by a TypeScript process on 2026-11-16 ([HOST_SERVICES_TS_PLAN.md](HOST_SERVICES_TS_PLAN.md)), so no Python is needed; P5 open.** Verified live on macOS with a temporary Anchi home: `anchi setup install -y` built the venv, the daemon started the proxy and the auth service, `anchi setup vault unlock` and `anchi host enable -y` wrote the settings and shims, a request through the registered port was audited for the `host` principal with TLS terminated against the written bundle, a placeholder was recognized, a link-local address was refused, and `anchi host disable` restored both files byte for byte. `scripts/verify-host.sh` (a real `claude -p` / `codex exec` through the shims) has not been run. The spike ran Claude Code 2.1.325 and Codex CLI 0.166.0 on a Mac with no Lima, under their own sandboxes, with every outbound request going through a local proxy that stood in for Anchi's egress proxy. Results are in [What the spike showed](#what-the-spike-showed). P1 gives `services/server.py` host listeners (`--listen <role>=<path>`, role by socket, own UID only), makes the egress proxy's control socket take the proxy's UID under `ANCHI_EGRESS_HOST=1`, and reads peer credentials on macOS as well as Linux; nothing starts these yet.

## Goal

Let a developer use Anchi's credential proxy, high-risk approvals and audit on their own machine, with the `claude` and `codex` they already have, without a VM or a change to how they start a session:

- no VM and no container: the runtime's own sandbox (Seatbelt on macOS, bubblewrap on Linux) is the boundary;
- the user keeps typing `claude` and `codex` in their own terminal and IDE;
- connector credentials (GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord) live in Anchi's vault and never enter the session;
- `push main`, secret endpoints and the other `HIGH_RISK` entries wait for the user's decision as they do today;
- the remote server stays as it is, as the hardened placement (the Lima VM placement this plan was written beside was removed on 2026-11-16; the host placement is now the default on a user's computer).

This is a **placement** next to `local` (remote server): the daemon, the egress proxy, the vault and the policy service all run on the user's machine as the user, and the runtime is not an Anchi cell but a session the user started.

## Not in scope

- Agents, triggers, delegation, teams and the builder. A host session is the user's own session; it has no agent file and no task tree. Agent features keep needing a cell.
- Protecting the host from the runtime. The sandbox limits what shell commands can read and reach; the runtime's own process, its built-in tools (Read, Edit, WebFetch, web search), MCP servers, hooks and commands the user types at the shell prompt run outside it. See [Boundary](#boundary).
- Enterprise policy distribution, SSO, central audit.

## What the spike showed

Scripts, settings and logs of the spike are not in the repository (they were run from a scratch directory); the findings they produced are:

**Claude Code** (`sandbox.enabled`, `allowUnsandboxedCommands: false`, `network.httpProxyPort` pointing at the local proxy, `credentials.envVars` with `mode: "mask"`, `filesystem.denyRead: ["~/.ssh"]`, `--settings` for the session):

- Every HTTPS request and git-over-HTTPS fetch from a sandboxed command reached the external proxy. A 403 from the proxy ended the command. `curl --noproxy`, a raw Python socket, `ls ~/.ssh` and git over SSH all failed inside the sandbox.
- With `httpProxyPort` set, Claude Code's own `allowedDomains` is not enforced; a host outside the list was reached through the external proxy. The external proxy is the only network decision.
- `mask` shows the command a per-session sentinel. With an external proxy the sentinel leaves unchanged (Claude Code warns at start that TLS termination is unavailable). A TLS-terminating external proxy replaced the sentinel with the real value, and the upstream saw the real header. Anchi's proxy already does this for `anchi-placeholder` credentials.
- Trust for the proxy's CA reaches sandboxed commands through the `env` settings key (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`). curl and git verified; Apple's Python 3.9 ignored `SSL_CERT_FILE` and needs an explicit `cafile`.
- Setting `HTTPS_PROXY` on the `claude` process instead of `httpProxyPort` sent the model API, MCP and telemetry traffic through the proxy and kept the built-in allowlist and masking, but the sandboxed commands' traffic did not chain to that parent proxy, contrary to the sandboxing guide. Not usable as the only path.

**Codex** (`-s workspace-write`, `features.network_proxy`, `HTTPS_PROXY` on the `codex` process, a named `permissions` profile):

- Codex has no external-proxy port. Its managed proxy chains to the upstream named by `HTTPS_PROXY` (`allow_upstream_proxy`, default true), and the Codex client's own `chatgpt.com` traffic follows the same variable. Every sandboxed command request reached the upstream; a 403 there ended the command (as a connection reset). `--noproxy` and raw sockets failed.
- The built-in `:workspace` profile reads `~/.ssh`, and `enable_socks5` (default true) let `git ls-remote git@github.com:…` out through the SOCKS listener without touching the HTTP upstream. A named profile with `filesystem."/Users/<user>/.ssh" = "deny"` and `network.enable_socks5 = false`, selected with `default_permissions`, closed both; `codex sandbox -- ls ~/.ssh` confirmed Seatbelt refuses the read, and a write outside the workspace is refused.
- Codex has no credential masking and keeps `*TOKEN*` variables in command environments by default (`shell_environment_policy.ignore_default_excludes`). Placeholders in the environment of the `codex` process, replaced by the TLS-terminating upstream, worked as in cells.

## Design

### 1. Topology

```text
user's terminal / IDE
  claude ───(sandbox: httpProxyPort)───┐
  codex  ───(managed proxy ⇒ HTTPS_PROXY)┤
                                        ▼
            anchi-egress  127.0.0.1:<port>   (mitmproxy addon, services/egress_proxy.py)
              │  credentials ──► secure-auth socket ──► vault        ~/.anchi/host/run/
              │  high risk  ───► approvals queue ◄── daemon ◄── desktop / TUI / CLI
              ▼
            GitHub, AWS, Linear, … and the model API
```

Everything runs as the user. The daemon starts the proxy and the trusted services as child processes (launchd agents later, if needed) and reaches the proxy's control socket directly instead of through `anchi-cell`.

### 2. How the session reaches the proxy

| Runtime | Commands in the sandbox | The runtime's own traffic (model API) |
|---|---|---|
| Claude Code | `sandbox.network.httpProxyPort` in `~/.claude/settings.json` | A shim (see 4) sets `HTTPS_PROXY`; optional in phase 2, since the model token is the user's own |
| Codex | `features.network_proxy` + `HTTPS_PROXY` in the process environment; the shim sets the variable | Same variable; always through the proxy |

Codex's own domain rules stay in front of Anchi's; Claude Code's are off once `httpProxyPort` is set. Anchi's proxy decides alone in both cases, with the same `egress_rules` as cells: a host session gets an open egress list unless the host profile narrows it.

### 3. One principal per machine, then per directory

Today the proxy identifies a cell by the local port of its bridge connection (`Registry.ports`), and each cell is registered by guest root over the control socket. Claude Code's external-proxy mode gives the proxy no username, so a session cannot carry its identity in the proxy URL.

Phase 1 registers one principal, `host`, with the proxy: one listener port, one set of grants (the connectors the user connected), one `ask` set and one `high_risk_disabled` set, stored as the **host profile** in the daemon's state. The audit and the approval cards say "host session" and name the destination; they cannot tell two concurrent sessions apart.

Phase 2 adds **directory profiles**: a listener port per profile, written into the project's `.claude/settings.json` and the project's Codex profile, so a repository can have narrower connectors or `ask` everywhere. Port-to-profile mapping reuses `Registry.ports`.

### 4. What Anchi writes, and how it is undone

`anchi host enable` (CLI and desktop) does, in order, recording every step in `~/.anchi/host/managed.json`:

1. Creates the proxy CA (mitmproxy's, as `guest/install-anchi.sh` does) and the trust bundle `~/.anchi/host/ca-bundle.pem` = system roots + CA.
2. **Claude Code**: merges into `~/.claude/settings.json` only these keys, keeping a copy of the previous file: `sandbox.enabled`, `sandbox.allowUnsandboxedCommands: false`, `sandbox.network.httpProxyPort`, `sandbox.filesystem.denyRead` (`~/.ssh`, `~/.aws`, `~/.anchi`, `~/.config/gh`, the vault and key paths), `env.*` for the five CA variables. It refuses when the file already has a `sandbox` block it did not write, and reports `excludedCommands` it finds.
3. **Codex**: adds to `~/.codex/config.toml` a `[permissions.anchi]` profile (`extends = ":workspace"`, the same deny paths, `network.enabled = true`, `network.enable_socks5 = false`, no domain rule, since Anchi decides), `[features] network_proxy = true` and `default_permissions = "anchi"`, keeping a copy. It refuses when `default_permissions` already names another profile.
4. **Shims**: `~/.anchi/bin/claude` and `~/.anchi/bin/codex`, which set `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, the CA variables and the connector placeholders (`GH_TOKEN`, `LINEAR_API_KEY`, … exactly as `cell_environment()` does) and `exec` the real binary. The user adds `~/.anchi/bin` to the front of `PATH`; `anchi host status` says whether the shim is the one found. IDE extensions that spawn the CLI from `PATH` pick the shim up; ones that bundle a binary do not, and the status says so.

`anchi host disable` restores the copies when the files still match what Anchi wrote, otherwise removes only the keys it set, and deletes the shims. Nothing is written atomically by the editors of those tools, so Anchi writes a temporary file and renames.

### 5. Trusted services without systemd or UIDs

On a remote server, `services/server.py` requires socket activation and gates operations by the caller's kernel UID (`credential_ops(caller)`, `auth.handle(request, caller)`). On the host there is one user, so:

- `server.py <mode> --listen <role>=<socket path> …` (P1, done) replaces `LISTEN_FDS`: one socket per caller role under `~/.anchi/host/run/`, mode 0600, and the role comes from the socket that accepted the connection. The peer's kernel UID must still be the service's own (`LOCAL_PEERCRED` on macOS, `SO_PEERCRED` on Linux); a connector service answers the `egress` role only, and the credential scope per role is unchanged. The proxy's control socket takes the proxy's UID instead of root when `ANCHI_EGRESS_HOST=1`; `ANCHI_EGRESS_SERVICE_SOCKET` names where connector sockets live.
- The role separation is code hygiene on the host, not a kernel boundary: the sandbox is what keeps a session away from these sockets (Claude Code denies Unix sockets unless `allowUnixSockets` lists them; Codex has `unix_sockets` with no default allow) and from the vault files (`denyRead`).
- The vault key lives on the same machine as the vault, as on a remote server; the daemon unlocks it from `~/.config/anchi` as today.

### 6. Approvals and audit

The proxy's `Approvals` queue, `approvals.watch` stream and `approvals.decide` are unchanged. The daemon's `ApprovalWatcher` gets a transport whose `spawn(['anchi-cell','approvals','watch'])` is replaced by a direct control-socket client; the desktop cards, the TUI Approvals view and `anchi approvals` work as they do for cells. The proxy's audit file moves to `~/.anchi/host/audit.jsonl`; a bounded `host.audit` RPC and a desktop view come in phase 3 (see the backlog's audit-log item).

### 7. Credentials

- Connector credentials: in the vault, obtained by the proxy through `secure-auth`, injected where `egress_rules` sees a placeholder. Unchanged.
- The runtime's own login stays the user's: Claude Code's OAuth in the keychain, Codex's `auth.json`. Anchi does not hold them on the host in phase 1.
- Real tokens the user already has on the machine are the main leak path: `gh` reads the keychain, `~/.config/gh/hosts.yml`, `~/.aws/credentials`, `.env` files. The deny-read list covers the files; keychain access from inside Seatbelt goes through a Mach service that both sandboxes deny by default. `anchi host status` lists the credential files it found outside the deny list, as the cell scan does today for homes.

## Boundary

What holds, with the sandbox on and the Anchi settings in place:

- A shell command the runtime runs cannot read the vault, the key, `~/.ssh`, `~/.aws` or the other denied paths; cannot open a direct TCP connection or resolve a name; cannot reach a Unix socket; cannot write outside the workspace and temp directories.
- Every request such a command makes passes Anchi's egress rules, credential injection, high-risk approvals and audit.
- A placeholder, not a credential, is what the command and the model see.

What does not hold, and must be stated in `SECURITY.md`:

- The runtime process itself and its built-in tools run outside the sandbox: Claude Code's Read, Edit, WebFetch and WebSearch, MCP servers, hooks and `!` commands; Codex's web search, MCP servers, apps, browser and computer use. A prompt-injected WebFetch can send a file the Read tool read.
- The user can turn the sandbox off, exclude commands, approve an unsandboxed retry (Claude Code) or a sandbox escalation (Codex). Anchi's settings disable the Claude Code retry; the rest is the user's choice on their own machine.
- Both sandboxes are user-space: no UID separation, shared kernel, and sandbox-runtime has had a CVE where the network sandbox was not enforced without a domain list. The VM remains the hardened placement.
- TLS trust is per tool: tools that do not honor the CA variables fail, and Go tools under Seatbelt need the documented `enableWeakerNetworkIsolation`, which widens the boundary.

## Options considered

| Option | How | Why not first |
|---|---|---|
| **A. Runtime's own sandbox + Anchi proxy** (proposed) | Settings and a shim; the sandbox is the vendor's | Only the shell commands are inside |
| B. Anchi starts the runtime in its own `sandbox-exec` / `bwrap` profile | A port of `anchi_cell.py` with the whole runtime inside, model traffic included | Changes how the user starts a session; nested sandboxes and the Codex Seatbelt bug are unverified |
| C. Apple `container` / Docker | A VM per cell, fast start | Still a VM and an install; the thing this plan removes |
| D. Rely on `HTTPS_PROXY` alone | No sandbox | Cooperative only; a script bypasses it |

B stays the path for Hermes, which has no sandbox of its own, and for agents that must run unattended.

## Milestones

| Step | Content | Test |
|---|---|---|
| P0 | Spike (done): both runtimes, proxy as decider, placeholder injection, bypass attempts | This document |
| P1 | Services without systemd: `--listen`, role by socket, control-socket check by UID; proxy audit path configurable | `tests/`: a connection on the egress socket may ask `egress_credential`, one on a connector socket may not; the control socket refuses another UID |
| P2 | Daemon `host` placement: `HostTransport`, host profile, `host.enable/disable/status` RPCs and CLI, settings and config writers with manifest and rollback, shims, approval watcher | Daemon tests with a fake proxy: register/unregister, watcher reconnect; writer tests: merge, refuse foreign `sandbox` block, restore |
| P3 | Desktop: "This computer" machine with placement `host`, enable flow with native confirmation, approval cards; docs (`docs/HOST_PLACEMENT.md`, `SECURITY.md`, `CHANGELOG.md`) | Existing desktop tests; `make check` |
| P4 | `scripts/verify-host.sh`: the spike's probes, run through a real `claude -p` / `codex exec` against the running proxy | Live, explicit, like `make verify-anchi` |
| P5 | Directory profiles, Linux host (bubblewrap), audit view | Later |

## Open questions

- Where the daemon lives on a Mac: `anchi` CLI as today, or the desktop app's bundled daemon only.
- Whether Claude Code's parent-proxy chaining (the `HTTPS_PROXY` run) is a bug or a version gap; if it starts working, the shim could be dropped for Claude Code.
- Codex per-project profiles: whether `default_permissions` can be set per directory without a shim argument.
- Hermes on the host: option B or not supported.
