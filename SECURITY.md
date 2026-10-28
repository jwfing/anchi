# Security model and reporting

Anchi is meant to be a secured agent team: agents that act on your accounts without ever holding their credentials, each limited to what it is configured with, with your approval in front of the writes that matter. This page states which boundaries hold and where they stop.

This is a development project. It has not completed a security audit and is not claimed suitable for unattended processing of sensitive real accounts.

## Trust boundaries

- **Untrusted:** everything inside a cell: the runtime (Codex, Claude Code or Hermes), its tools and processes, the cell runner and the in-cell MCP server, skills, session files and model output.
- **Trusted:** the host OS and administrator, the Anchi daemon, TUI, CLI and desktop app (`anchi/packages/{core,daemon,tui,desktop,protocol}`), the host scripts, guest administration, and the vault, auth, policy, connector and egress services.
- **Remote server:** with the daemon on a [remote server](docs/REMOTE_SERVER.md), that machine's administrator, its login user (whoever can SSH in) and its hosting platform are trusted as the host is. The vault key lives on the same machine as the encrypted vault. A snapshot or fork carries both, and the daemon unlocks the vault with it after a restart. The client reaches the daemon only through SSH and `anchi-bridge`; nothing listens on the network.
- Upstream credentials never enter the cell. External policy and connectors control requested operations. Hiding keys does not prevent every misuse of an otherwise valid interface.
- Read content may enter agent context and cloud models. Credential isolation must not be described as keeping sensitive content on the host.
- Clients strip control characters and escape sequences from agent text. Security decisions (builder proposals, agent settings changes, agent deletion, approvals, setup steps, secret input) use full-screen dialogs drawn by Anchi that agent output cannot reproduce; the Approvals view decides held writes the same way, in a pane that draws no agent transcript. Agent files change only after such a dialog shows the diff, or by your own edits.

The desktop can hold several owner-authenticated daemon connections at once. Every call,
notification and cached record is scoped to a machine; daemon-local ids are never resolved
against whichever machine happens to be selected later. Unknown and disconnected targets
are refused. Native confirmation dialogs identify the machine and pin the connection that
was reviewed; a disconnect, reconnect or removal during the dialog refuses submission.
Switching machines clears credential forms. Vaults and runtime logins remain on their machines;
showing their agents together does not grant new delegation or copy credentials.

## Cross-server teams

A team coordinator may execute a logical member as an existing agent on a saved remote
server. The coordinator and every execution node are trusted owner daemons. Connections use
the existing SSH/instabox bridge to the owner's mode-0600 socket; there is no new listening
service, and cells receive neither SSH credentials nor daemon access. Selecting an execution
profile authorizes use of that profile's runtime, connectors and policy. The coordinator's
wrapper does not override the node's approvals, egress, workspaces or connector grants.

An imported cell's Anchi calls are queued on its execution daemon and fetched by the
coordinator. Both daemons validate the fixed team tool surface and delegation allowlist;
the coordinator establishes task identity, verifies child ownership, rejects cycles, and
applies the depth, child and turn budgets to the complete tree. Remote tools cannot name a
server, forge their parent, change configuration or approve operations. Connector operations
and their approval checks stay on the execution node. The coordinator shows the complete
pending action, logical member, node and origin chain; a decision is scoped to that remote
job and its pending approval, with the original policy digest enforced on the node.

Dispatch and team tool effects have durable idempotency records. Reconnecting repeats the
same dispatch, never a new turn; a cancellation tombstone also covers a dispatch that has
not arrived. The remote node identity and transport target are pinned once dispatched, so
replacing a node database fails the task instead of silently running it elsewhere. Restarting
the execution daemon still interrupts its cells; writes are not automatically retried.
These guarantees cover Anchi dispatch and delegation, not arbitrary external operations
that an agent or a user chooses to repeat.

Task input, events, results, approval content and usage cross the SSH connection and persist
on the coordinator and execution node. Vaults, login files, workspace files and runtime
session ids are not copied. Deleting a task clears its queued tool content and coordinator
state on that daemon; the other node retains its own history until separately deleted or
expired. Worker receipts retain ids and hashes to refuse delayed duplicate dispatches.

## Authorization modes

Policy stores a mode for each connector service (Gmail, Drive, Notion, Slack, X, Reddit), and optionally one per agent and service (`notion:<agent>`) that an agent's `approvals: {notion: ask}` sets. Agent writes through the egress proxy (GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord) follow the agent's `approvals` and the high-risk list; see the agent team section below.

- **`auto` (default, standing authorization):** connecting authorizes use. Allowlisted operations and parameters receive one-time grants automatically; reads and writes are audited without a human click.
- **`ask` (per-request approval):** each operation requires independent review of the normalized full action and digest. Approval applies only to that exact content and expires if not granted within ten minutes.

Older policy databases without an explicit new mode also default to `auto`; explicit modes are retained. A legacy read-only grant is not equivalent to the new standing read/write mode. Review the permissions page after upgrading.

Both modes retain these constraints: credentials stay outside the cell; connector operation/path allowlists and size limits still apply; updates bind to a current target revision and recheck before writing (`TARGET_CHANGED`); each connector allows at most 200 writes daily; uncertain outcomes are not retried; policy decisions and execution are audited. Mode changes increment the policy epoch and revoke all unconsumed grants.

Standing authorization accepts prompt-injection risk: instructions embedded in mail, files, pages or messages can cause an agent to write without an intervening human gate. The remaining controls are the allowlists, revision checks, quotas and audit above. Use per-request approval when you want to inspect each operation.

X and Reddit publish under the user's public identity, so their writes default to `ask` when no rule exists; their reads are always automatic. `anchi setup service-mode x auto` (or `reddit`) sets `auto` for every agent, and an agent's `approvals: {x: auto}` gives that agent its own `auto` rule, which applies even while the service asks. In `auto`, any task of such an agent, including a prompt-injected one that a trigger started to read mentions, issues or mail, can post publicly under the user's account without a person seeing the text. What remains is the operation and size limits, the daily write limit, replay protection and the audit. The TUI asks for confirmation before it sets `auto`, the CLI prints a warning, and a builder proposal with `auto` says so before it is applied; an agent file edited by hand gets no prompt. The policy service in the VM enforces this rule after `anchi setup install`; an older one still refuses `auto` for X and Reddit.

In either mode, an agent's own tool calls inside its cell (shell, files, network through the proxy) run without individual approval; the cell is the boundary.

## Authentication and connectors

Reddit uses a separate trusted service (`secure-reddit`) with only `oauth.reddit.com` egress.
An approved installed app starts authorization-code sign-in with one-time state and the fixed
callback `http://127.0.0.1:48174/callback`; this provider flow does not use PKCE. The Client ID
and developer username identify the app; no password, client secret or browser cookie is
imported. The host sends the code on stdin. Only `secure-auth` exchanges, refreshes or revokes
tokens, at `www.reddit.com`, and verifies the account at `oauth.reddit.com`. Separate auth roles
open those destinations only while a flow, credential or revocation exists. Scopes are exactly
`identity`, `read`, `submit`; only the Reddit service UID gets its access token, never refresh
tokens. Disconnect holds the refresh lock and retains failed revocation for retry.

Reddit exposes bounded list/search/read/comment-tree tools and text self posts/comments.
In `ask` (the default), publishing requires exact-content approval of the verified account, full
content and subreddit/title or parent id, bound to the connection generation. In `auto` (see
Authorization modes) posts and comments go out without it. Reads are automatic; fields and output bytes are bounded and marked untrusted.
HTTP 200 API errors are checked explicitly; ambiguous writes remain UNKNOWN in the shared
ledger and are not replayed. Reddit content can persist in task histories and model sessions;
there is no automatic deletion synchronization with Reddit.

X is a trusted connector service (`secure-x`) with access only to `api.x.com`. A user-supplied
native public Client ID starts PKCE sign-in with state and the fixed loopback callback
`http://127.0.0.1:48173/callback`. Authorization codes reach the VM on stdin; access and refresh
tokens remain in the encrypted vault. Only the X service's kernel UID can obtain its access
token; the egress proxy cannot read or inject it. OAuth exchange, refresh and revocation run
as `secure-auth`, whose separate `xauth` network role permits that provider only while a flow,
credential or revocation exists. Scopes are checked against the exact requested set.

X exposes bounded post lookup, recent search, own mentions and text publishing only. In `ask`
(the default), X publishing requires an exact-content approval; in `auto` (see Authorization
modes) it does not. Reads are automatic. The frozen action names the verified account id and handle, text and reply
target, and binds to the connection generation. Changing the account invalidates the request.
The shared write ledger prevents replay after success or uncertain execution. Reads reserve
up to 1,000 requested post resources per UTC day across agents in persistent SQLite, with a
maximum of 25 per page. These limits do not replace X's monetary spending limit.
HTTP 402 payment refusals are reported with a fixed error code; provider error bodies are never
reflected to cells. Payment refusals do not cause automatic retries or mark an OAuth login revoked.

The daemon detects host Codex and Claude Code logins at startup, after environment setup, on
credential file changes and every five minutes. Once the installed VM's vault is unlocked,
valid local subscription logins are imported automatically. Codex reads `~/.codex/auth.json`
(or `$CODEX_HOME/auth.json`); Claude reads its directory-specific macOS Keychain entry or
`.credentials.json` in `CLAUDE_CONFIG_DIR` (default `~/.claude`). Reads are bounded and reject
non-regular or symlinked credential files. Only access tokens, Codex's account id and Claude's
expiry enter the vault, over stdin. Refresh tokens stay on the host, where the CLIs refresh
them. Discovery reports only installation/login state; errors and logs contain no token data.
`codexAutoImport: false` and `claudeAutoImport: false` disable each automatic import. A stored
Codex account is not switched automatically; manually supplied Claude tokens/API keys are not
overwritten. The trusted auth service refuses expired host Claude tokens just as it does Codex tokens.

Google sign-in uses the system browser, an ephemeral `127.0.0.1` port opened by the daemon, state and PKCE. Google tokens enter only the VM authentication layer. Invalid refresh credentials set reauthentication-required and stop further Google requests until the user reconnects. Gmail has no task-scoped sender/folder restrictions. Cancelling a local task cannot withdraw an upstream request or automatically revoke pending approvals.

Drive, Notion and Slack follow the Gmail service boundary: separate UIDs and sockets, provider-specific TCP 443 egress and registry-defined read/write operations. Both reads and writes follow the configured authorization mode. In `ask`, the complete write content is frozen for review. Static Notion/Slack tokens are entered without echo in the CLI or a masked full-screen dialog in the TUI, and go to the vault over stdin. Notion has no remote token-revocation API. A cell reaches only its agent's connector services, through a bridge in `anchi-egress` that names the agent (`notion:<agent>`) on every request; the services accept a named agent only from the bridge's UID, and a cell never sees a service socket itself. An agent's `approvals: {notion: ask}` holds its writes, not its reads; the service-wide mode still applies to every agent, and the daily write limit stays per service.

Approval waits retain the same request. Frozen actions persist; target preparation does not hold a database write lock. Frozen content is retained for at most seven days while execution records remain for replay protection. Write quota is reserved before preparation. Uncertain remote outcomes are UNKNOWN. Read-only POST operations such as Notion search are not treated as writes.

Drive text updates require a nonempty revision and recheck it immediately before writing. `If-Match` is sent only when a strong ETag exists; ETags are not mandatory. Without an ETag, the revision precheck has a check/write race. Notion's edit-time check has the same limitation. Neither is atomic concurrency control. Google Docs overwrite is refused; read and create remain available.

## Agent team: task cells and the egress proxy

The agent team (`anchi/`, `guest/anchi_cell.py`, `services/egress_*.py`) runs Codex, Claude Code and Hermes agents in per-task cells. Its boundaries:

- **Credentials never enter a task cell.** Cells hold placeholders and the Codex account id, which is an identifier rather than an authenticator. The `anchi-egress` proxy reads the proxy connectors' credentials (GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord) and the runtimes' from `secure-auth`, whose kernel-UID check limits them to that service, and injects or re-signs them on matching requests. It never adds a runtime credential to a request that did not carry a placeholder. Token refresh happens on the trusted side.
- **Credential isolation is not data isolation.** Unmatched traffic passes through the proxy unchanged so agents can install packages and read the web; an agent's `egress` list, when set, limits which hosts that traffic may reach (checked when the proxy opens the upstream connection). An agent can send anything it can read to any public host. Connectors grant their full upstream authority, minus the deny lists, so use a dedicated least-privilege principal for AWS and a fine-grained, repository-scoped token for GitHub. Every rule, credential and egress decision is made on the host the connection goes to; a request whose `Host` header names another host is refused (HTTP 400, audited as `host-mismatch`), so a header cannot earn a credential for a connection elsewhere. Credentials are injected only on the service's API paths (Sentry `/api/0/`, Discord and PostHog `/api/`), and deny lists refuse calls whose response would carry a new credential: key and token creation (GitHub, AWS, Linear, PostHog, Sentry) and Discord webhooks, whose objects carry their own token. **Firecrawl fetches any URL for the agent**, so an agent with it reaches pages outside its `egress` list, and the URLs it asks for can carry data out.
- **Destinations are filtered.** The proxy refuses non-public addresses (the ranges its nftables backstop rejects, IPv4-mapped and NAT64 IPv6 addresses included, read from one list) and connects to the address it checked, so DNS rebinding cannot redirect it. The nftables rules for the proxy UID reject private ranges as a backstop. Cells have loopback-only networking and reach the proxy only through their own socket. That socket also identifies the cell, and so its agent and connectors.
- **The cell is the boundary for Codex.** Codex runs in `danger-full-access` inside an unprivileged, user-namespaced, capability-free nspawn cell with a volatile root and a persistent per-agent home. The home belongs to the agent and keeps what earlier tasks left, so the cell manager writes Codex's placeholder files into it without following links: a link, file or directory left where `.codex` or its files go refuses the cell (`AGENT_HOME_LINK`) instead of creating or handing over what the link names. The per-agent `codex-workspace-write` opt-in loads an AppArmor profile that lets `bwrap` create user namespaces VM-wide.
- **No ChatGPT Apps or plugins.** The Codex token is the user's ChatGPT login, which also reaches the apps the user linked in ChatGPT (Slack, Gmail, GitHub and others) through Codex's `codex_apps` MCP server. Those calls would act as the user, outside the agent's connectors, approvals and audit, so the proxy refuses `/backend-api/ps/`, `/backend-api/plugins/`, `/backend-api/aip/` and `/backend-api/connectors/` on `chatgpt.com` for every request, and the runner starts Codex with `features.apps` and `features.plugins` off. Other `chatgpt.com` paths still receive the token, so a Codex agent can reach what that login can reach on `chatgpt.com` itself.
- **The daemon treats the cell runner as untrusted.** Frames are size-limited and schema-checked, and events must belong to the running turn; the first violation ends the cell. Clients strip escape sequences and control characters from all agent text. Builder proposals are written only after a full-screen confirmation.
- **Claude Code** is handled like Codex: the cell holds a placeholder (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), the proxy replaces it on `api.anthropic.com` only, and OAuth token exchange and organization administration are denied. Claude Code runs with permission checks bypassed and no settings files loaded; the cell is the boundary.
- **Hermes** talks to an OpenAI-compatible endpoint the user stores (base URL, API key, model). The key stays in the vault; the cell's Hermes config holds a placeholder. The proxy builds the cell's rule from the stored endpoint at registration: it substitutes the key on that host, under the base URL's path and nowhere else, replace-only, and refuses OpenAI-style administration paths there. The endpoint must be HTTPS on a public name with no built-in rule, so it cannot claim another credential's host. A cell keeps the rule it started with; if the stored endpoint moves to another host, the proxy refuses to send the new key to the old one. Hermes's command and edit approvals are off, its configured MCP servers and runtime package installs are disabled; the cell is the boundary. The endpoint sees everything Hermes sends it, like any model provider.
- **Anchi tools come from the cell and are checked by the daemon.** The in-cell MCP server and the runner are untrusted relays. The daemon knows each cell's task and agent from its runner channel and allows a call only if that agent may make it (`delegates`, its own child tasks).
- **Gmail, Drive, Notion and Slack:** a cell sees no service socket. It gets bridge sockets for its agent's own service connectors only; the bridge in `anchi-egress` forwards each request with the cell's agent and, for Gmail and Drive, the Google account the agent's file names (`default` otherwise), overriding anything the cell sent; the services accept a named agent or account only from the bridge's UID. Policy grants are per agent (`notion:<agent>`); an agent's `ask` holds its writes, the service-wide mode applies to every agent (except that an agent's `auto` for X or Reddit overrides the service's `ask` for that agent), and the daily write limit stays per service.
- **Held writes.** With `approvals: {<connector>: ask}` the proxy holds an agent's writes before fetching the credential, and sends nothing upstream unless the user approves in the approval dialog or the Approvals view, both drawn by Anchi with the write's details; it refuses after five minutes, or after `approvalTimeoutMinutes` from `~/.anchi/settings.yaml` (1 to 720; the daemon sends it to the proxy, which keeps it across restarts). Reads are never held. The dialog shows the git refs or the start of the body, which is agent-originated text; the audit log records the outcome, not the body. A held write proves the user saw that request, not that the agent's other traffic is harmless.
- **Listed high-risk operations are held by default for every agent and origin** (merges, repository deletion and settings, branch protection and access, pushes to `main`/`master`, ref deletion, AWS deletion and access changes, Linear deletion, PostHog and Sentry deletions and member changes, Figma webhooks, Discord deletions, moderation, roles, permissions and settings), with the task's origin chain in the dialog. `highRisk.disable` in `~/.anchi/settings.yaml` exempts patterns for every agent; the same field in an agent file exempts them for that agent, edited by hand or in the agent settings panel, which writes it only after a dialog shows the diff and each new exemption. An explicit `approvals: {<connector>: ask}` still holds those writes. The list is a fixed set of patterns: an equivalent operation through another endpoint, or a force-push to another branch, is not covered.
- **Delegation and triggers widen what untrusted input can reach.** A polled issue or a delegated task text becomes another agent's task input. `delegates` allowlists and `approvals` on writes are the controls; delegation depth and turn limits only stop loops. Polls run fixed read-only queries in the egress service with the vault credential; no cell is involved.
- **Workspaces** (macOS and Linux): `~/AnchiWorkspaces` is mounted in the VM, and a cell gets only its agent's directories under it, read-only unless `rw`. Paths are checked in the daemon and again in the cell manager (no `..`, no symlinks on the way). An `rw` workspace lets the agent write files that run on the Mac later; Anchi mounts each workspace from a descriptor resolved under the share without following links, masks git hooks, config and info and common editor and shell configuration read-only the same way (a name a cell or the Mac changes while a cell starts cannot move a mask or the mount; a writable folder with more than 1000 masked paths refuses the cell), and audits each turn for new hooks, command-running git configuration, outside symlinks, new executables and editor configuration. Files run by design (`package.json`, `Makefile`) remain the user's to review. What an agent reads in a workspace can leave through the proxy like anything else it reads. Deleting an agent never removes workspace files: the binds exist only in the cell's mount namespace, and the VM removes an agent's home only when it has no cell and no mount point below it, without crossing file systems.
- **Every cell is scanned before it is destroyed** (idle timeout, cancellation, replacement, daemon shutdown): its processes (nested sandboxes included), their environment and the files changed since the cell started (by ctime, which a cell cannot set back; the Mac's directories and the image's toolchains are not read) are compared with the vault's real values, and a finding is recorded in the task and raises a notification. A scan that reaches 200,000 files, 2 GiB or 90 seconds stops and is reported as cut short, in the task and as a notification, like a finding. Only labels are reported, never values.
- **Egress lists.** A refused host is noted in the task. Allowing it (from the task's access view or `anchi agents allow-host`) adds that exact host to the agent's file after the user confirms; the host name comes from the agent's request, and allowing it opens a destination for whatever the agent reads.
- **Large requests.** A request body over 8 MiB streams through the proxy and its headers leave before the body is read, so on that path the proxy injects only S3 calls (their operation comes from method and path) and git pushes. A git push without a length streams from its headers: its headers leave with the credential, and none of its body leaves until the ref updates at its start have been read. A high-risk or unreadable push is then refused: upstream gets an empty push, which changes nothing, and the push is not held for approval. Pushes of an agent whose GitHub writes ask are buffered and held as before. Any other streamed request leaves without credentials and is audited as `pass:streamed`.
- **Push ref updates.** Every ref update of a push is read, as git's pkt-lines. A push whose updates do not parse or run past 64 KiB is high-risk (`github-push-unreadable`), as is a GitHub GraphQL request whose document cannot be read: not a JSON object with a string `query`, or longer than 1 MB (`github-graphql-unreadable`); neither entry can be switched off.
- **Skills are untrusted content**, copied read-only into the cells of the agents that list them. A skill from GitHub is pinned to the commit it was fetched at; updating it installs only the commit whose changes the user reviewed.
- **Service units cannot read the shared directories or reach the cells' sockets.** `/mnt/anchi-host` and `/mnt/anchi-host-raw` are inaccessible to every service unit except the one that mounts them, and `/run/anchi-egress` to the authentication, policy and connector services. Each cell's proxy and bridge sockets belong to the proxy and the cells' group (`0660`, their directories `0750`), so no other VM user can connect as a cell and be served with its credentials. An image build's cell runs as cell root, outside that group, and its proxy injects no credential, so its socket stays reachable by every VM user.
- **Audit.** `/var/log/anchi-egress/audit.jsonl` records method, host, path, operation, decision, task and agent, and whether the cell sent a placeholder, nothing or a credential of its own, never header values or query strings. The user sees a task's rows with `anchi audit TASK` or **^X l** on the task; the daemon reads them through a fixed guest command that takes only a task id. They are written by the trusted proxy, but hosts and paths come from the agent's requests and are rendered as agent text. The file rotates at 50 MB and keeps one older file; the daemon saves each task's rows when its cells close, so a task's record lasts as long as the task. When a cell sends a credential that is not a placeholder, the proxy alerts the daemon at once (a note in the task and a desktop notification); this flags a credential that reached the cell from elsewhere, and does not stop the request. `make verify-anchi` runs the live isolation checks, and `anchi scan TASK` checks a live cell for real credential values.
- **Subscription limits.** The proxy reads the limits of the Codex and Claude subscriptions from responses it injected credentials into: Codex's rate-limit message in the model stream (plan, percent used, window length and reset time, all bounded) and Claude's `anthropic-ratelimit-*` headers (printable, bounded). It parses only that message type and keeps nothing else of the stream. The values live in the proxy's memory and are not a security control.

## Isolation and platform limits

Guided preparation combines environment installation, vault initialization/unlock and runtime
image preparation after one trusted confirmation. It never replaces an existing master key or starts a task. Available local runtime logins
connect automatically after the vault is ready; agent configuration and sending the sample
task remain separate user actions. A missing key with encrypted credentials still requires
restoring the original key.

Prebuilt release layers are trusted software, like the app bundle. Their manifest is shipped
inside that bundle and fixes each archive's version, architecture, recipe compatibility, size
and SHA-256. The guest checks the full archive before extraction into a private staging directory,
rejects traversal, links used as parent directories, unmapped owners and unsupported special
files/xattrs, maps ownership into the cell UID range, and publishes the layer by rename.
Only overlay whiteouts and opaque-directory markers are supported. Downloads contain no
accounts, agent homes, workspace data or proxy CA. A checksum failure stops installation;
these checks do not constitute publisher signing. Source installations build layers locally.

Linux and macOS share the same trust boundaries: services and cells run inside a Lima VM. Linux uses QEMU/KVM and QEMU user-mode NAT; the host administrator grants `/dev/kvm` access. The user installs Lima (Homebrew on macOS); the Linux CI pins Lima by SHA-256. Inside the VM, Node, Codex and Claude Code are pinned by version and SHA-256 in `guest/cell.env`, not by publisher signatures.

The daemon's task store (`~/.anchi/data/anchi.db`, mode 0600 directory) keeps task transcripts, including agent-originated text and tool output, on the host. Finished tasks are deleted after `retentionDays` (default 90), and `anchi rm` deletes a task at once. Full policy audit remains in the VM policy database and the egress audit log; both are read through trusted administration. Cell and service JSON uses UTF-8 byte limits.

Installing (`setup install`) and `make verify-anchi` restart or reap cells, so both refuse while task cells are live in the VM, unless explicitly forced. An image build under way counts as a live cell, and `anchi-cell reap` leaves it running.

Host and VM administrators can access trusted components. nspawn shares the guest kernel. Passing isolation tests does not prove escape is impossible. Allowed model/connector channels do not prevent every form of content exfiltration.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/jwfing/anchi/security/advisories/new) to send a report to the maintainer. The repository has no dedicated public security email or bug bounty program. Do not post real tokens, mail, credential-file contents or directly usable private attack material in public issues.

Include the affected version, environment, minimal synthetic reproduction, expected boundary and observed behavior. Fixes involving approval, credential reads, process escape or egress bypass require regression coverage. See the [security foundation](docs/SECURITY_FOUNDATION.md) for deployment details.
