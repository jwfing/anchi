# Remote server

By default the Anchi daemon runs on your computer and drives a Lima VM there. A remote server runs the same daemon, trusted services and task cells on a Linux machine elsewhere, so agents and triggers keep running while your computer sleeps. The machine can be a VM from any provider that you reach with SSH. [instabox](https://instabox.sh) is the recommended provider: `scripts/remote.sh` creates the machine for you. The TUI and CLI stay on your computer and reach the server's daemon through SSH.

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
- **DNS.** The egress proxy may query the resolvers `/etc/resolv.conf` names on port 53. Under Lima, that is the systemd-resolved stub, `127.0.0.53`. An instabox machine names public resolvers.
- **Separate teams.** Each server keeps its own agents, tasks and vault, and agents on different servers cannot reach each other.
- **Verified so far:** `instabox:` on Debian 13 x86_64 (`make verify-vm` and `make verify-anchi` with `ANCHI_GUEST=local` on the server). `ssh:` targets have not been tested live.

## Live checks on the server

```bash
instabox ssh anchi-server -- 'cd ~/anchi && ANCHI_GUEST=local make verify-vm verify-anchi'
```
