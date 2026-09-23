# Security model and reporting

This is a development project. It has not completed a security audit and is not claimed suitable for unattended processing of sensitive real accounts.

## Trust boundaries

- **Untrusted:** the entire agent, extensions, tool processes, session files and model output inside the cell.
- **Trusted:** the host OS and administrator, desktop main process, runtime scripts, guest administration, and auth/policy/connector services.
- Upstream credentials never enter the cell. External policy and connectors control requested operations. Hiding keys does not prevent every misuse of an otherwise valid interface.
- Read content may enter agent context and cloud models. Credential isolation must not be described as keeping sensitive content on the host.
- The desktop renderer has no Node access, networking or arbitrary navigation. It uses allowlisted IPC; agent content is escaped as text.

## Host directory access

The host file broker records device and inode at native confirmation. Grants last until revoked; startup restores only unchanged directory identities. Moved, replaced or inaccessible directories become inactive and require confirmation. The broker opens path components with `O_NOFOLLOW`, enforces read-only/read-write modes, and rejects hidden paths, symlinks, hard links and special files.

Deletion and overwrite preserve old content in a private `.anchi-trash` inside the granted directory. The agent cannot list or read it. This reduces data loss from prompt injection but is not version control; users manage retention and restore files on the host. Overwrite copies and syncs old content before atomically replacing the original. Failure preserves the original path, and old content larger than 24 KB cannot be overwritten. Fixed-length trash IDs have JSON sidecars recording original relative paths.

Revocation immediately blocks new requests and waits for already-started bounded operations. It cannot retract content already read. Other host processes and administrators are trusted; the broker does not defend against their concurrent relocation of open directories. Access is limited to bounded UTF-8 text, not a general POSIX mount.

Writable grants cannot overlap app code, runtime resources, real tool directories or known installation roots. Restored grants undergo the same checks. Invalid tool paths do not prevent startup, and a standalone executable in `~/bin` does not cause the entire home directory to be treated as an installation root.

## Authorization modes

Policy stores a mode for each connector (Gmail, Drive, Notion, Slack) and model inference:

- **`auto` (default, standing authorization):** connecting authorizes use. Allowlisted operations and parameters receive one-time grants automatically; reads, writes and model calls are audited without a human click.
- **`ask` (per-request approval):** each operation requires independent review of the normalized full action and digest. Approval applies only to that exact content and expires if not granted within ten minutes.

Older policy databases without an explicit new mode also default to `auto`; explicit modes are retained. A legacy read-only grant is not equivalent to the new standing read/write mode. Review the permissions page after upgrading.

Both modes retain these constraints: credentials stay outside the cell; connector operation/path allowlists and size limits still apply; updates bind to a current target revision and recheck before writing (`TARGET_CHANGED`); each connector allows at most 200 writes daily and each VM at most 50 distinct model requests daily; uncertain outcomes are not retried; policy decisions and execution are audited. Mode changes increment the policy epoch and revoke all unconsumed grants.

Standing authorization accepts prompt-injection risk: instructions embedded in mail, files, pages or messages can cause the model to write or make another model call without an intervening human gate. The remaining controls are the allowlists, revision checks, quotas and audit above. Use per-request approval when you want to inspect each operation. Restoring standing authorization presents a native confirmation explaining this risk.

In either mode, local tool calls from a model turn (cell bash/read/write and `host_files` within granted directories) execute without individual approval. Limit read/write grants to intended output directories.

## Authentication and connectors

Desktop OAuth uses the system browser, an ephemeral `127.0.0.1` port, state and PKCE. Google tokens enter only the VM authentication layer. Invalid refresh credentials set reauthentication-required and stop further Google requests until the user reconnects. Gmail has no task-scoped sender/folder restrictions. Cancelling a local task cannot withdraw an upstream request or automatically revoke pending approvals.

Drive, Notion and Slack follow the Gmail service boundary: separate UIDs and sockets, provider-specific TCP 443 egress and registry-defined read/write operations. Both reads and writes follow the configured authorization mode. In `ask`, the complete write content is frozen for review. Static Notion/Slack tokens enter through a separate main-process window, never the agent-content renderer. Notion has no remote token-revocation API. Pi registers tools only for connected connectors.

Approval waits retain the same request. Frozen actions persist; target preparation does not hold a database write lock. Frozen content is retained for at most seven days while execution records remain for replay protection. Write quota is reserved before preparation. Uncertain remote outcomes are UNKNOWN. Read-only POST operations such as Notion search are not treated as writes.

Drive text updates require a nonempty revision and recheck it immediately before writing. `If-Match` is sent only when a strong ETag exists; ETags are not mandatory. Without an ETag, the revision precheck has a check/write race. Notion's edit-time check has the same limitation. Neither is atomic concurrency control. Google Docs overwrite is refused; read and create remain available.

## Isolation and platform limits

Linux and macOS share the same trust boundaries: services and the cell run inside a Lima VM. Linux uses QEMU/KVM and QEMU user-mode NAT. The host administrator grants `/dev/kvm` access; the app displays privileged commands but does not execute them. Lima and Codex downloads verify the pinned SHA-256 in `desktop/host-tools.json`, not Lima GPG or Codex sigstore signatures. Downloads accept only HTTPS GitHub release hosts.

Desktop `activity.jsonl` stores event metadata (type, time, tool and approval identifiers), not chat, approval bodies or RPC results. Full policy audit remains in the VM policy database and is read through the trusted administration interface. Cell/service JSON uses UTF-8 byte limits.

Host and VM administrators can access trusted components. nspawn shares the guest kernel. Passing isolation tests does not prove escape is impossible. Allowed model/connector channels do not prevent every form of content exfiltration.

## Reporting a vulnerability

Use an existing private contact channel with the maintainer. The repository has no dedicated public security email or bug bounty program. Do not post real tokens, mail, credential-file contents or directly usable private attack material in public issues.

Include the affected version, environment, minimal synthetic reproduction, expected boundary and observed behavior. Fixes involving approval, credential reads, process escape or egress bypass require regression coverage. See the [security foundation](docs/SECURITY_FOUNDATION.md) for deployment details.
