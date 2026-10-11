# Getting started

Anchi runs its agents in a Lima VM on your machine. You install the `anchi` app, prepare the
VM's prerequisites, create the VM, then connect a runtime and build your first agent.

| Host | Status | VM layer |
|---|---|---|
| macOS on Apple Silicon | Supported | Lima + Virtualization.framework |
| Linux x86_64 with glibc (Ubuntu 22.04+ / Debian 12+) | Experimental; KVM CI uses Ubuntu 24.04 | Lima + QEMU/KVM |

Arch, Fedora and other distributions may work but are not covered by CI.

Choose one way to install:

| | Binary release | From source |
|---|---|---|
| For | Using Anchi | Developing or testing unreleased changes |
| Needs | `curl` | Git, Node 22+, pnpm |
| Command | `anchi` | `scripts/anchi` in the checkout |
| Updates | `anchi update` | `git pull`, then reinstall dependencies |

Both ways need the same VM prerequisites, which differ per platform. The VM uses 4 GB of RAM
and up to 30 GB of dynamically allocated disk; keep at least 8 GB of disk free.

## Install the binary release

The release installer downloads Anchi and its bundled Node runtime, verifies the archive's
SHA-256 checksum, and installs an `anchi` command. Git, Node and pnpm are not required. It does
not need sudo or modify your vault, agents or VM.

### macOS

1. Install the VM prerequisites with [Homebrew](https://brew.sh):

   ```bash
   brew install lima python
   ```

2. Install the app:

   ```bash
   curl -fsSL https://anchi.elseward.xyz/install.sh | sh
   ```

3. If the installer says your bin directory is missing from PATH, open a new terminal or run
   the `export PATH=…` line it prints.
4. Continue with [Set up the VM and your first agent](#set-up-the-vm-and-your-first-agent).

### Linux

1. Install QEMU and make sure you can use KVM. Follow [Linux prerequisites](#linux-prerequisites).
2. Install Lima. Follow [Install Lima on Linux](#install-lima-on-linux).
3. Install Python 3.11+ (`python3 --version`); most distributions ship it.
4. Install the app:

   ```bash
   curl -fsSL https://anchi.elseward.xyz/install.sh | sh
   ```

5. If the installer says your bin directory is missing from PATH, open a new terminal or run
   the `export PATH=…` line it prints.
6. Continue with [Set up the VM and your first agent](#set-up-the-vm-and-your-first-agent).

### Installer options

The installer configures your shell for future sessions; a script piped into `sh` cannot change
the parent terminal's environment.

- Install a specific release with
  `curl -fsSL https://anchi.elseward.xyz/install.sh | ANCHI_VERSION=v0.2.0 sh`.
- `ANCHI_INSTALL_ROOT` overrides the default `~/.local/share/anchi`.
- `ANCHI_BIN_DIR` overrides the command directory. By default the installer prefers a writable
  `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin` already on PATH, falling back to
  `~/.local/bin`.

## Install from source

A source checkout runs the TypeScript sources directly through `scripts/anchi`. Use
`scripts/anchi` wherever this guide says `anchi`. `scripts/anchi setup install` also builds the
cell runner from the checkout.

### macOS

1. Install the prerequisites:

   ```bash
   brew install git node pnpm lima python
   ```

   Node must be 22 or newer (`node --version`); `.nvmrc` names the version CI uses.
2. Clone the repository and install the workspace dependencies:

   ```bash
   git clone https://github.com/jwfing/anchi.git
   cd anchi
   pnpm --dir anchi install
   ```

3. Check that the launcher starts:

   ```bash
   scripts/anchi --help
   ```

4. Continue with [Set up the VM and your first agent](#set-up-the-vm-and-your-first-agent),
   running `scripts/anchi` from the checkout.

### Linux

1. Install QEMU and make sure you can use KVM. Follow [Linux prerequisites](#linux-prerequisites).
2. Install Lima. Follow [Install Lima on Linux](#install-lima-on-linux).
3. Install Git, Python 3.11+ and Node 22+ with your package manager or a version manager such
   as nvm or mise. `.nvmrc` names the Node version CI uses.
4. Install pnpm. Node 25 and newer no longer bundle corepack, so install pnpm directly with one of:

   ```bash
   npm install -g pnpm                # any Node install
   mise use -g pnpm                   # if mise manages your Node
   corepack enable pnpm               # Node 22–24 only
   ```

   `anchi/package.json` names the pnpm version the project pins in `packageManager`.
5. Clone the repository and install the workspace dependencies:

   ```bash
   git clone https://github.com/jwfing/anchi.git
   cd anchi
   pnpm --dir anchi install
   ```

   If `scripts/anchi` later fails with `Cannot find module …/node_modules/tsx/dist/loader.mjs`,
   this step has not run.
6. Check that the launcher starts:

   ```bash
   scripts/anchi --help
   ```

7. Continue with [Set up the VM and your first agent](#set-up-the-vm-and-your-first-agent),
   running `scripts/anchi` from the checkout.

### Development checks

The offline checks need a Python virtual environment with the test dependencies:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
make check PYTHON=.venv/bin/python
```

`make check` does not access a VM, an account or a model. Once the VM is installed,
`make verify-vm` and `make verify-anchi` run the live isolation checks (no credentials used).
See [CONTRIBUTING.md](../CONTRIBUTING.md) for the daily workflow.

### Update a source checkout

```bash
git pull
pnpm --dir anchi install
scripts/anchi setup install    # when the change touches the VM, services or cell runner
```

`anchi update` does not modify a checkout.

## Linux prerequisites

The host needs x86_64 CPU virtualization and a readable and writable `/dev/kvm`.

1. Install QEMU:

   | Distribution | Command |
   |---|---|
   | Debian / Ubuntu | `sudo apt-get install -y qemu-system-x86 qemu-utils` |
   | Arch | `sudo pacman -S --needed qemu-base` |
   | Fedora | `sudo dnf install -y qemu-system-x86 qemu-img` |

2. Check KVM access:

   ```bash
   ls -l /dev/kvm
   ```

   If it is missing, enable virtualization (VT-x or AMD-V) in the firmware settings. If your
   user cannot read and write it, run `sudo usermod -aG kvm "$USER"` and log in again.
3. Optionally install `notify-send` for desktop notifications (Debian/Ubuntu `libnotify-bin`,
   Arch `libnotify`); without it notifications are skipped.

`anchi setup install` stops early if `/dev/kvm` or QEMU is missing.

### Install Lima on Linux

Install Lima from its [release page](https://github.com/lima-vm/lima/releases) and verify the
archive against the release's `SHA256SUMS`. CI pins version 2.2.0
(`.github/workflows/linux-live.yml`). Without sudo, into `~/.local`:

```bash
VER=2.2.0
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/lima-vm/lima/releases/download/v$VER/lima-$VER-Linux-x86_64.tar.gz"
curl -fsSLO "https://github.com/lima-vm/lima/releases/download/v$VER/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
mkdir -p ~/.local/lima ~/.local/bin
tar -xzf "lima-$VER-Linux-x86_64.tar.gz" -C ~/.local/lima
ln -sf ~/.local/lima/bin/limactl ~/.local/lima/bin/lima ~/.local/bin/
limactl --version
```

`~/.local/bin` must be on PATH.

## Set up the VM and your first agent

These steps are the same for both installation methods and both platforms. From a source
checkout, replace `anchi` with `scripts/anchi`.

### Guided setup in the TUI

Run `anchi`. The TUI opens without a VM. First launch opens **Getting started**, which detects
completed steps and guides you through prerequisites, environment installation, vault
initialization/unlock, runtime login, Agent builder and a first task. Press **Enter** for the
next step; **Ctrl+X, L** shows installation logs and **Ctrl+X, !** opens persistent error
details and recovery actions. Agent builder currently requires a Codex login. Teams with setup
and a first task complete open on **Team overview**; **Ctrl+X, 0** reopens the guide.

### Step by step

1. **Install the VM and services.** In **Runtimes**, press `I`, or run:

   ```bash
   anchi setup install          # asks for confirmation; add --yes to skip it
   ```

   Installation creates the `anchi-vm` VM, installs the trusted services and prebuilt cell
   runners, and builds the base image. It takes several minutes and can be rerun to update;
   completed steps are reused.
2. **Initialize and unlock the vault:**

   ```bash
   anchi setup vault init       # first time only
   anchi setup vault unlock     # after each VM start
   ```

   The master key is `~/.config/anchi/vault.key`. Back it up; a replacement key cannot
   decrypt stored accounts.
3. **Connect a runtime.** These operations are also available in **Runtimes**.
   - Codex: install its CLI and run `codex login` on this machine, then `anchi setup codex`.
     Anchi reads `~/.codex/auth.json`; Codex must store its login in that file, not in a
     keyring.
   - Claude Code: run `claude setup-token`, then `anchi setup claude` and paste the token.
4. **Build an agent.** Select **Agent builder** and describe your first agent. **Connectors**
   connects GitHub, AWS, Linear, Gmail, Drive, Notion and Slack. See the
   [agent team guide](AGENT_TEAM.md).
5. **Optionally start the daemon at login:** `anchi daemon install`. On macOS this is a launch
   agent; on Linux a systemd user unit (`~/.config/systemd/user/anchi-daemon.service`). To keep
   it running on Linux after you log out, run `loginctl enable-linger "$USER"`.

Model calls consume your subscription quota. Anything an agent reads can reach the model
and, through the proxy, any public host.

## Linux differences

- **Workspaces** (`~/AnchiWorkspaces`) are shared over 9p instead of virtiofs. The VM maps the
  share with `bindfs`, so in a cell the agent owns its files, files it creates are yours on the
  host, and no other user in the VM can write to the share. Sharing (W on the Runtimes screen)
  also reinstalls the guest components, which bring `bindfs` and the mapping.
- **Notifications** use `notify-send`; without it they are skipped.
- **Google sign-in** opens the browser with `xdg-open` and also prints the URL. Google redirects
  to a port on `127.0.0.1`, so the browser must run on the same machine; over SSH, forward the
  printed port or sign in on a desktop session.
- **The VM** lives in `~/.lima/anchi-vm`, as on macOS. Where guides say "the Mac", read "this
  machine".

## Update or remove the app

Run `anchi update` to check GitHub and install the latest release. Use `anchi update --check`
to check without changing anything. Updates verify the archive's SHA-256 and requested version,
then atomically switch the active package. An up-to-date or newer local version is left alone;
failed downloads or checks leave the current installation intact. Custom install roots and
launchers are preserved, and updating does not rewrite shell configuration.

Versions through 0.2.1 do not include this command: rerun the installer once after a release
with self-update is available. Source checkouts and manually extracted archives should use
the installer to obtain a managed installation; self-update does not modify a checkout.

Existing daemon processes keep using the old version
so installation does not interrupt running tasks. Once tasks finish, run `anchi daemon stop`,
then reopen `anchi`. If you enabled login startup, rerun `anchi daemon install` too so its
service points to the new version. Run `anchi setup install` when the release notes require
VM/service updates. Older packages remain under `~/.local/share/anchi/versions` and can be
removed once no daemon or login service uses them.

To remove the app, first run `anchi daemon uninstall` and `anchi daemon stop`, then delete
only the installed `anchi` launcher and the install root. Your `~/.anchi` data, vault and Lima
VM are separate and retained. Remove the installer's PATH line from your shell config if desired.

### Start over (reset)

`anchi setup reset` returns the machine to a first launch, for example to try the guided setup
again. It refuses while tasks are running or queued, lists what it deletes and asks you to type
`reset` (`--yes` skips the question). It deletes the `anchi-vm` VM with everything in it:
the vault's encrypted credentials (Codex, Claude Code, Google, Notion, Slack, GitHub, AWS,
Linear), agent homes, built images and the audit log. Idle cells are closed first.

| | `anchi setup reset` | `anchi setup reset --all` |
|---|---|---|
| The VM and the vault contents | deleted | deleted |
| `~/.config/anchi/vault.key` | kept | deleted |
| `~/.anchi` (or `ANCHI_HOME`): agents, templates, images, skills, `settings.yaml`, the task database, logs | kept | deleted (the daemon is stopped first) |
| `~/.anchi/keybindings.json` | kept | kept (a preference, not setup state) |
| `~/AnchiWorkspaces`, the installed app, Google/GitHub/AWS accounts themselves | kept | kept |

Without `--all`, your agents survive: run `anchi setup install` and `anchi setup vault init`,
which creates a new, empty vault with the same key, then connect accounts again. Credentials
are deleted locally only; revoke them at the provider if you no longer want them to exist
(disconnect Google accounts before resetting to revoke their tokens). A login service from
`anchi daemon install` stays installed and starts the daemon again at the next login.


## Recovery

- **Installation failed:** check networking and disk space, then run `anchi setup install` again. Completed steps are reused; workspaces and credentials are kept.
- **Installation refused because tasks are running:** installing restarts the egress proxy, which would end them. Wait for them (`anchi tasks`) or cancel them, then run it again; `ANCHI_FORCE_RESTART=1` installs anyway. `make verify-anchi` refuses for the same reason (`ANCHI_CHECK_WITH_TASKS=1` runs it beside them, leaving their cells alone).
- **Interrupted installation:** run it again. Installer-marked incomplete root filesystems are kept as `rootfs-incomplete-*` before rebuilding; unmarked ones are never modified automatically.
- **Stopped VM:** `anchi setup vm`, then `anchi setup vault unlock`.
- **Vault cannot unlock:** restore the original master key.
- **Expired Codex token:** run `codex` on this machine once, then `anchi setup codex` again.
- **Google requires sign-in again:** `anchi setup service gmail` (or `drive`; add `--account <name>` for a named account). Testing-mode OAuth refresh tokens commonly expire after seven days.
- **Start from scratch:** `anchi setup reset` (see [Start over](#start-over-reset)).
- **Approval refused or timed out:** the agent sees the refusal; send the task a follow-up once the cause is fixed.

## Inside the VM

`limactl shell anchi-vm` opens a shell in the VM over Lima's SSH, which listens on `127.0.0.1` only, with a key in `~/.lima/_config`. You get your own user with passwordless sudo: this is the trusted side, at the level of the host administrator. Useful places:

- `sudo anchi-cell list`: the running cells.
- `sudo ls /var/lib/anchi/agents/<agent>/home`: an agent's persistent home, with its work directory and Codex and Claude sessions.
- `/var/log/anchi-egress/audit.jsonl`: the egress audit log (`anchi audit <task>` reads it for you).

Agent cells have no SSH and no interactive shell: nothing runs an SSH server in them, and they reach the network only through the egress proxy. For a look inside a running cell, `anchi-cell exec` runs one command as the agent user, without input:

```bash
limactl shell anchi-vm -- sudo anchi-cell exec <task> -- /bin/sh -c 'ls -la; env | sort'
```

A cell lives until 10 minutes after its task's last turn; after that, look in the agent's home instead.

As root in the VM:

- Treat an agent's files as untrusted: do not run its scripts or source its configuration as root.
- Do not restart `anchi-egress` or other services, or run `anchi-cell reap`, while tasks run: like installing, it cuts their cells off.
- Do not paste credentials into the VM's shell; they go to the vault through `anchi setup` or the TUI (Runtimes, Connectors).
