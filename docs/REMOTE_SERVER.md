# Remote server

By default the Anchi daemon runs on your computer and drives a Lima VM there. A remote server runs the same daemon, trusted services and task cells on a Linux machine elsewhere, so agents and triggers keep running while your computer sleeps, as long as the machine runs (see [Keep an instabox server running](#keep-an-instabox-server-running)). The machine can be a VM from any provider that you reach with SSH. [instabox](https://instabox.sh) is the recommended provider: `scripts/remote.sh` creates the machine for you. The TUI and CLI stay on your computer and reach the server's daemon through SSH.

```text
your computer                          remote server (Debian or Ubuntu, systemd, passwordless sudo)
anchi TUI / CLI ── SSH session ──► anchi-bridge ─► ~/.anchi/run/daemon.sock (daemon, ANCHI_GUEST=local)
                                                   └─ sudo -n ─► vault, policy, connectors, egress, task cells
```

On the server, the daemon runs inside the guest: it reaches guest root with `sudo -n` instead of `limactl shell`, and the machine itself takes the place of the VM. Cells, the egress proxy and the trusted services are the same as in the VM. `anchi-bridge` joins the SSH session's stdio to the daemon's socket. SSH authenticates you, the socket stays mode 0600, and nothing listens on the network.

## Set up a server

In the desktop app, open **Settings → Machines → Add a machine** and enter an existing instabox
machine or SSH host. If Anchi is missing, a native dialog names the machine and offers
**Initialize**. It downloads the app's matching published release, checks its SHA-256, installs
`anchi-bridge` and starts the daemon as a systemd user service. A source checkout and Node are
not needed on either machine. The server needs Linux x86_64 with glibc, systemd, Python 3.11+,
curl, tar, flock and passwordless sudo. SSH must already work from this computer.

After connecting, continue the environment preparation guide and connect a runtime on that
server. Host credentials are not copied. An instabox server keeps agent data in `/data/anchi`;
other SSH servers use `/var/lib/anchi`. Desktop initialization leaves the provider's pause
settings unchanged; configure them as described below for scheduled work. If initialization
is cancelled or fails, the saved machine keeps an **Initialize** button. Interrupted initial
installs can be retried with the same app version. Existing configured servers with a damaged
installation require the source-based repair below; initialization does not restart their tasks.

For source development, other supported architectures or server updates, from a source checkout
on your computer:

```bash
scripts/remote.sh instabox:anchi-server      # creates the instabox machine when missing (--no-vault)
anchi server add cloud instabox:anchi-server # saves it under a short name
anchi server cloud                           # this computer now uses it
anchi setup install                          # trusted services, cells and the base image, on the server
anchi setup vault init
```

Any other host works the same way with an `ssh:` target:

```bash
scripts/remote.sh ssh:dev@build.example.com
anchi server add build ssh:dev@build.example.com
anchi server build
```

`scripts/remote.sh` copies the checkout to `~/anchi` on the server. It then runs `scripts/server-install.sh` there, which:

- installs the packages with the pnpm version `anchi/package.json` pins (a corepack shim in `~/.local/bin`);
- installs `/usr/local/bin/anchi-bridge`;
- enables lingering for the login user;
- runs the daemon as the systemd user unit `anchi-daemon.service` with `ANCHI_GUEST=local`.

The script refuses while task cells run, because restarting the daemon ends them. Run it again to update the server, then `anchi setup install`.

### Where Anchi keeps its data

Agents' homes (their checkouts, caches and build output) and the image layers live under `/var/lib/anchi` on the server, and grow with use: an agent that builds Go or Node projects keeps gigabytes of caches. `scripts/remote.sh <target> --data-dir <path>` keeps them on a disk of your choice instead. An instabox machine uses `/data/anchi` unless you name another path: `/data` is its data disk, the one you can resize, while its root disk stays small. An SSH host keeps `/var/lib/anchi` unless you pass `--data-dir`, and `--data-dir /var/lib/anchi` means the same.

`guest/anchi_data_dir.py` does this as root, with the daemon stopped:

- it refuses a path that is relative, contains `.` or `..`, lies inside `/var/lib/anchi` or the login user's home, or is on a filesystem other than ext4, xfs or btrfs (the image layers are overlays);
- it creates the directory (root, mode 0700), copies the existing data there with its owners, checks the copy, and bind-mounts it at `/var/lib/anchi` with the systemd unit `var-lib-anchi.mount`, so the cell manager and the checks keep their paths;
- it adds a drop-in that keeps the egress proxy out of the new path, as its unit keeps it out of `/var/lib/anchi`;
- only then it removes the old copy. If the mount fails, the data stays where it was.

Running it again with the same directory changes nothing. Moving the data a second time, to another directory, is refused. The copy needs room for all of the data plus 512 MB. A cell refuses to start with `DISK_FULL` when the disk holding `/var/lib/anchi` has under 512 MB free.

### Keep an instabox server running

instabox pauses a machine once it has been idle for 30 minutes (no agent working, no terminal use, little CPU), and on the free plan after 480 running minutes as well. A daemon waiting for its next schedule or poll counts as idle, and a paused machine runs no triggers until something resumes it. For an instabox target, `scripts/remote.sh` therefore turns both off, on new and existing machines:

```bash
instabox auto-suspend anchi-server 0   # no idle pause
instabox max-run anchi-server -1       # no runtime limit
```

Only paid plans allow this. On the free plan the script warns and the machine keeps pausing: tasks you start run while you use it, but triggers stop when it pauses. `instabox get anchi-server --json` shows the settings (`autoSuspendAfterSeconds` null, `maxRunMinutes` -1).

`ssh:<[user@]host>` targets a Debian or Ubuntu host with Python 3.11+ and passwordless sudo, whoever provides it. The source setup also needs Node.js 22+; desktop initialization supplies Node in the release package. The client runs `ssh -T -o BatchMode=yes`, so the host must be reachable with keys.

## Saved servers

`local`, the daemon on this computer, is always in the list. You add the remote servers:

| Command | What it does |
|---|---|
| `anchi server` or `anchi server ls` | Lists `local` and the saved servers, `*` before the one in use |
| `anchi server add <name> <target>` | Saves a target under a name |
| `anchi server rm <name>` | Forgets a saved server; if it was in use, `local` is from then on |

The list is in `~/.anchi/servers.json` (mode 0600, replaced as a whole on every change). A name is 1 to 40 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. `local`, `ls`, `add` and `rm` are reserved. Two entries cannot share a name or a target. Entries of the file that are not valid are skipped. A file that is not JSON lists only `local`, and `add` and `rm` refuse to overwrite it.

## Choose the server

| How | Scope |
|---|---|
| `anchi server <name or target>` | Saved in `~/.anchi/server`; `anchi server local` goes back |
| `ANCHI_SERVER=<name or target>` | This shell |
| `anchi --server <name or target> …` | One command |

Targets are `local`, `instabox:<machine>` and `ssh:<[user@]host>`. Any other target is refused, and so is a target SSH would read as an option. A target does not have to be saved to be used.

`anchi server <name or target>` connects before it saves the choice. When the host answers but has no `anchi-bridge`, it names the command that installs Anchi there, `scripts/remote.sh <target>`. When SSH cannot log in or nothing answers within 15 seconds, it says so and keeps the previous choice.

## Runtimes and connectors

- **Codex and Claude Code logins** are the server's. Sign in on the server and the daemon imports the login as it does on a computer: `instabox ssh anchi-server`, then `codex login --device-auth`, and `claude` followed by `/login`. A Claude token or API key also works from your computer: `anchi setup claude`.
- **Token connectors** (GitHub, AWS, Linear and the others) are entered on your computer as usual. They go to the server's vault over the SSH session and then on stdin to the vault. `anchi setup connector github --from-gh` and `--profile` read `gh` and `aws` on the server, not on your computer.
- **Browser sign-ins** (Google, X, Reddit) open in your computer's browser. While the sign-in waits, the client listens on the same loopback callback port (`127.0.0.1:<port>`) and relays the callback to the daemon through `anchi-bridge tcp <port>`. The redirect URI the provider sees is unchanged.

## One team, multiple execution nodes

Select one **coordinator** for the team. The TUI and CLI connect to it; the desktop app can keep
several machines connected and selects the coordinator for team configuration. Its agents are
the team's members; an optional `execution` field places a member on another server. The coordinator
keeps the complete task tree, dispatches work, collects results and usage, and shows pending
approvals from the execution nodes. A remote member can delegate to a local member or to a
member on a different remote node through the same coordinator.

Upgrade the coordinator and execution nodes to a version with `team.*` RPCs. Prepare each
node's runtime, credentials and agent profiles as usual. For a local coordinator and an
existing remote agent named `coder`:

```bash
anchi server add cloud ssh:dev@build.example.com  # skip if already saved
anchi --server local team nodes
anchi --server local team add developer --node cloud --agent coder --preview
anchi --server local team add developer --node cloud --agent coder --yes
anchi --server local run developer "Review the repository and report your findings"
```

In the desktop app, use **Agent builder**, start a new conversation if needed, enter the
team member's id, select **Run on → cloud**, enter the existing node agent id and choose
**Preview**, then **Apply**. The binding is shown in the member header, its read-only
settings and the task details. The builder can propose changes to the binding with a whole
agent file. The CLI's `team add` is create-only.

The resulting coordinator file `~/.anchi/agents/developer.yaml` contains:

```yaml
name: Developer
runtime: codex                       # schema field; actual runtime comes from the node
execution: {server: cloud, agent: coder}
delegates: [reviewer]                 # logical team ids, on the coordinator
```

A local lead can list `developer` in its `delegates`. To let the remote developer delegate
back to the coordinator's `reviewer`, also set `delegates: [reviewer]` in the execution node's
`~/.anchi/agents/coder.yaml`. Both grants are required. A foreign delegate id may be written
directly in the execution profile; it does not need a local agent of that name there. It is
resolved against the coordinator only for imported team tasks. An ordinary task started
directly on that node still resolves delegates locally. `team add` copies only the remote
profile's delegates that already exist in the coordinator team; it does not modify the
execution profile. Add further grants with Agent builder or by editing the files.

The node profile determines the runtime, prompt, image, skills, connectors, workspaces,
accounts, egress and approval policy. The coordinator member determines its display name,
description, allowed team delegates, triggers and concurrency; the node's concurrency limit
also applies. Local access fields in the coordinator wrapper do not change node permissions.
Configure scheduled work on the coordinator; existing triggers on a node remain independent.

Saved aliases are read **on the coordinator**, not on the desktop client. If the coordinator
is itself remote, save its execution nodes with `anchi server add` while logged into that
machine, and arrange SSH/instabox access from there. The coordinator makes all connections;
remote cells need no route back to your laptop and never receive SSH keys.

Operational behavior:

- Closing the GUI does not stop work. The coordinator daemon must stay running and reachable
  to dispatch tasks, process delegation and relay approvals. An execution node can continue
  its current turn while disconnected, but team calls wait and its normal turn timeout still
  applies. Pending writes retain their node-side approval timeout.
- A lost connection retries the same dispatch. Coordinator restarts reattach dispatched
  tasks without creating another turn. Cancellation is durable and stays pending until the
  node confirms; no replacement task is launched elsewhere. Restarting the execution daemon
  interrupts its cells and reports failure; an explicit follow-up can continue afterwards.
- Tasks keep their original execution binding, and a dispatched task pins the resolved
  transport and node identity. Changing a member affects new tasks. A replaced node database
  fails existing tasks; source history should not be cloned to create a different node.
- Task results and URLs are shared; files and workspaces are not synchronized. Pass a Git
  commit, repository URL or another shared artifact reference for collaboration on files.
- Each node keeps its vault, sessions and local audit log. The coordinator mirrors retained
  events, results and usage. It reports a gap if remote events expired while disconnected;
  in that case the transcript and usage may be incomplete. Subscription quotas and raw
  egress audit reports remain node-local. Delete history separately on each node.

The offline integration suite exercises real daemon sockets and SQLite stores with simulated
cells, including multi-hop delegation, recovery, cancellation and approval scoping. The
desktop has also been checked against local and instabox daemons for simultaneous agent lists,
per-machine settings and remote member previews. Model-driven cross-server delegation and
recovery have not been tested live.

## Limits

- Workspaces (`anchi setup workspaces`), `anchi setup reset` and `anchi daemon install` do not apply to a remote server. Delete or recreate the machine to reset it.
- **Vault key.** The master key is in `~/.config/anchi/vault.key` on the server (0600, in a 0700 directory). Neither cells nor the trusted services can read it. The server's administrator, anyone who can SSH in as its login user, and for instabox the platform itself can. A snapshot or fork of the machine copies the key together with the encrypted vault. On a Lima host, by contrast, the key stays outside the VM.
- **Restarts.** The unlocked master key lives in tmpfs, so a restart of the server (a reboot, a disk resize, an instabox stop and start, not a pause) locks the vault. Because the key is on the same machine, locking it there protects nothing, and the daemon unlocks it again when it starts, so triggers keep working after a restart. Its log says `unlocked the vault with the vault key on this server`. A Lima VM's vault stays locked after a restart until you unlock it (**Unlock** in the desktop app, Getting started in the TUI, or `anchi setup vault unlock`).
- **DNS.** The egress proxy may query the resolvers `/etc/resolv.conf` names on port 53. Under Lima, that is the systemd-resolved stub, `127.0.0.53`. An instabox machine names public resolvers.
- **Separate storage.** Each server keeps its own agents, task copies and vault. A coordinator joins selected execution profiles into one team; merely switching servers does not merge their teams.
- **Verified so far:** `instabox:` on Debian 13 x86_64 (`make verify-vm` and `make verify-anchi` with `ANCHI_GUEST=local` on the server). `ssh:` targets have not been tested live.

## Live checks on the server

```bash
instabox ssh anchi-server -- 'cd ~/anchi && ANCHI_GUEST=local make verify-vm verify-anchi'
```


## Equal peer teams

A peer team has no designated coordinator. Each daemon owns its agents and task execution,
exchanges a signed directory with the other members, and delegates straight to the recipient.
After initial discovery, `newuser` can ask `dora` to work while `local` is disconnected.
Closing the desktop app does not stop any daemon. An unreachable executor remains unavailable;
Anchi does not move its task to another machine or replay the turn automatically.

Upgrade every daemon before enrollment. Existing `execution:` members keep the legacy
coordinator behavior described above; peer discovery does not convert them. Start a fresh task
after configuring peers to use distributed delegation.

### Connect machines

Each daemon needs a TCP address reachable from every other member, such as a private VPN
address. An SSH/Instabox connection in Machines gives the desktop owner access; it does not
create peer reachability. Anchi does not include a relay, tunnel or NAT traversal service.
Use **Settings → Peer team** on each machine, configure its label, reachable `tls://host:port`,
listen address and port, then choose one configured machine under **Join with a machine**.
The app exchanges public identities through your existing owner connections and asks for native
confirmation on each machine. Credentials and private keys are never exchanged.

Equivalent CLI example, replacing the example addresses with your reachable addresses:

```bash
anchi team network --label local --listen 0.0.0.0 --port 9847 --address tls://100.64.0.1:9847
anchi --server newuser team network --label newuser --listen 0.0.0.0 --port 9847 --address tls://100.64.0.2:9847
anchi --server dora team network --label dora --listen 0.0.0.0 --port 9847 --address tls://100.64.0.3:9847
anchi team join newuser
anchi team join dora
anchi team peers
```

Enroll only owner-controlled, trusted daemons. Enrollment authorizes a daemon to assign work,
relay human decisions for its task tree, introduce members and propagate revocations. All nodes
share that authority. It is not a boundary between mutually distrustful users.

### Assign work and grant delegation

Team shows discovered agents grouped by machine, including the last known directory when a
machine is offline. A direct desktop connection takes precedence over a discovered copy.
A discovered agent can receive a task through any connected member; that member retains the
submission record and mirrors its results. This view contains work submitted through that member,
not all historical tasks on the executor. Open the machine directly to edit its runtime,
connectors, skills or agent configuration, or inspect its full history and local audit log.

In an agent's **Delegation** settings, select recipients by their agent and machine labels.
Local recipients still use `developer`; peer recipients use the exact
`<node-id>/<agent-id>/<generation>` printed by `anchi team peers`. Discovery does not grant
delegation. Every hop checks the calling agent's own allowlist and runs with the recipient's
local access rules. Deleting and recreating an agent changes its generation; an old grant must
be reviewed again. The builder copies these ids from inventory rather than inventing wrappers.

### Recovery and limits

Each immediate parent persists a dispatch outbox; each executor stores a receipt before starting
its cell. Repeated dispatch with the same content attaches to the existing task. Changed content
under the same request and turn is refused. Origin restart resumes polling; executor restart
fails its interrupted turn. Continue or retry through the originating task, explicitly.
Cancellation remains pending until the executor acknowledges it, including when requested while
offline. A cancellation received before dispatch prevents the cell from starting.

Results, bounded transcripts and the descendant task tree propagate back through the parents.
A disconnected parent sees updates and approvals when it reconnects. Other reachable members
continue their own work. Approval decisions remain scoped to the authenticated originating node
and its exact task tree; the executor rechecks the pending policy decision.

There are at most 32 machines, 200 published agents per machine, three delegation levels,
ten immediate children per task and 60 execution turns in a distributed tree. A task reserves
up to ten turns for each child (half its remaining range, at least one); those ranges never
overlap. Unused reservations are not reclaimed, so a branch can exhaust its allowance before
the whole team uses 60 turns. Start a fresh task when the allowance is exhausted.

Use **Revoke…** or `anchi team revoke <node-id>` to remove a member. Revocation spreads when
members reconnect; it cannot instantly reach an isolated machine and does not cancel cells
already running there. A revoked identity cannot rejoin. Revocation takes precedence over old
directory snapshots. Directory data contains metadata only; vault contents, runtime logins,
sessions, workspaces and raw audit logs remain on their owning machines.

Peer networking and task recovery are exercised by real loopback TLS connections between test
daemons with simulated cells. Production VPN routing and model-driven collaboration with real
accounts require separate live validation.
