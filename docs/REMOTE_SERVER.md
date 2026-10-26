# Remote server

By default the Anchi daemon runs on your computer and drives a Lima VM there. A remote server runs the same daemon, trusted services and task cells on a Linux machine elsewhere, so agents and triggers keep running while your computer sleeps, as long as the machine runs (see [Keep an instabox server running](#keep-an-instabox-server-running)). The machine can be a VM from any provider that you reach with SSH. [instabox](https://instabox.sh) is the recommended provider: `scripts/remote.sh` creates the machine for you. The TUI and CLI stay on your computer and reach the server's daemon through SSH.

```text
your computer                          remote server (Debian or Ubuntu, systemd, passwordless sudo)
anchi TUI / CLI ── SSH session ──► anchi-bridge ─► ~/.anchi/run/daemon.sock (daemon, ANCHI_GUEST=local)
                                                   └─ sudo -n ─► vault, policy, connectors, egress, task cells
```

On the server, the daemon runs inside the guest: it reaches guest root with `sudo -n` instead of `limactl shell`, and the machine itself takes the place of the VM. Cells, the egress proxy and the trusted services are the same as in the VM. `anchi-bridge` joins the SSH session's stdio to the daemon's socket. SSH authenticates you, the socket stays mode 0600, and nothing listens on the network.

## Set up a server

From a source checkout on your computer:

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

`ssh:<[user@]host>` targets any Debian or Ubuntu host with Node.js 22+, Python 3.11+ and passwordless sudo, whoever provides it. The client runs `ssh -T -o BatchMode=yes`, so the host must be reachable with keys.

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

## Limits

- Workspaces (`anchi setup workspaces`), `anchi setup reset` and `anchi daemon install` do not apply to a remote server. Delete or recreate the machine to reset it.
- **Vault key.** The master key is in `~/.config/anchi/vault.key` on the server (0600, in a 0700 directory). Neither cells nor the trusted services can read it. The server's administrator, anyone who can SSH in as its login user, and for instabox the platform itself can. A snapshot or fork of the machine copies the key together with the encrypted vault. On a Lima host, by contrast, the key stays outside the VM.
- **Restarts.** The unlocked master key lives in tmpfs, so a restart of the server (a reboot, a disk resize, an instabox stop and start, not a pause) locks the vault. Because the key is on the same machine, locking it there protects nothing, and the daemon unlocks it again when it starts, so triggers keep working after a restart. Its log says `unlocked the vault with the vault key on this server`. A Lima VM's vault stays locked after a restart until you unlock it (**Unlock** in the desktop app, Getting started in the TUI, or `anchi setup vault unlock`).
- **DNS.** The egress proxy may query the resolvers `/etc/resolv.conf` names on port 53. Under Lima, that is the systemd-resolved stub, `127.0.0.53`. An instabox machine names public resolvers.
- **Separate teams.** Each server keeps its own agents, tasks and vault, and agents on different servers cannot reach each other.
- **Verified so far:** `instabox:` on Debian 13 x86_64 (`make verify-vm` and `make verify-anchi` with `ANCHI_GUEST=local` on the server). `ssh:` targets have not been tested live.

## Live checks on the server

```bash
instabox ssh anchi-server -- 'cd ~/anchi && ANCHI_GUEST=local make verify-vm verify-anchi'
```
