# Getting started

macOS on Apple Silicon is supported; glibc Linux x86_64 is experimental.

## Install the app

The release installer downloads Anchi and its bundled Node runtime, verifies the archive's
SHA-256 checksum, and installs an `anchi` command. Git, Node and pnpm are not required.
Run:

```bash
curl -fsSL https://anchi.elseward.xyz/install.sh | sh
anchi
```

If the installer says your bin directory is missing from PATH, open a new terminal or run
the `export PATH=…` line it prints. It configures your shell for future sessions; a script
piped into `sh` cannot change the parent terminal's environment.

Install a specific release with `curl -fsSL https://anchi.elseward.xyz/install.sh | ANCHI_VERSION=v0.2.0 sh`.
`ANCHI_INSTALL_ROOT` overrides the default `~/.local/share/anchi`; `ANCHI_BIN_DIR` overrides
the command directory. By default the installer prefers a writable `~/.local/bin`,
`/opt/homebrew/bin` or `/usr/local/bin` already on PATH, falling back to `~/.local/bin`.
It does not need sudo or modify your vault, agents or VM.

## First use on macOS

The TUI opens without a VM. First launch opens **Getting started**, which detects completed steps and guides you through prerequisites, environment installation, vault initialization/unlock, runtime login, Agent builder and a first task. Press **Enter** for the next step; **Ctrl+X, L** shows installation logs and **Ctrl+X, !** opens persistent error details and recovery actions. Agent builder currently requires a Codex login. Teams with setup and a first task complete open on **Team overview**; **Ctrl+X, 0** reopens the guide.

To configure these steps individually:

1. Install VM prerequisites: `brew install lima python`. Keep at least 8 GB of free disk;
   the VM uses 4 GB of RAM and up to 30 GB of dynamically allocated disk.
2. In **Runtimes**, press `I` to install the VM and services, then initialize/unlock the vault.
   The equivalent CLI commands are:

   ```bash
   anchi setup install
   anchi setup vault init       # first time only
   anchi setup vault unlock     # after each VM start
   ```

   Installation includes prebuilt cell runners and creates the base image. It takes several
   minutes and can be rerun to update. Back up `~/.config/secure-vm/vault.key`;
   a replacement key cannot decrypt stored accounts.
3. Connect a runtime. For Codex, install its CLI, run `codex login` on the Mac, then
   `anchi setup codex`. For Claude Code, run `claude setup-token`, then `anchi setup claude`
   and paste the token. These operations are also available in **Runtimes**.
4. Select **Agent builder** and describe your first agent. **Connectors** connects GitHub,
   AWS, Linear, Gmail, Drive, Notion and Slack. See the [agent team guide](AGENT_TEAM.md).

`anchi daemon install` optionally starts the daemon at login.
Model calls consume your subscription quota. Anything an agent reads can reach the model
and, through the proxy, any public host.

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

## Develop from source

Clone the repository, install Node 22+ and pnpm, and run:

```bash
pnpm --dir anchi install
scripts/anchi
```

In this mode use `scripts/anchi` wherever this guide says `anchi`. The source launcher runs
TypeScript directly. `scripts/anchi setup install` also builds the cell runner. Run
`make verify-anchi` from the checkout for live isolation checks (no credentials used).

## Recovery

- **Installation failed:** check networking and disk space, then run `anchi setup install` again. Completed steps are reused; workspaces and credentials are kept.
- **Installation refused because tasks are running:** installing restarts the egress proxy, which would end them. Wait for them (`anchi tasks`) or cancel them, then run it again; `ANCHI_FORCE_RESTART=1` installs anyway. `make verify-anchi` refuses for the same reason (`ANCHI_CHECK_WITH_TASKS=1` runs it beside them, leaving their cells alone).
- **Interrupted installation:** run it again. Installer-marked incomplete root filesystems are kept as `rootfs-incomplete-*` before rebuilding; unmarked ones are never modified automatically.
- **Stopped VM:** `anchi setup vm`, then `anchi setup vault unlock`.
- **Vault cannot unlock:** restore the original master key.
- **Expired Codex token:** run `codex` on the Mac once, then `anchi setup codex` again.
- **Google requires sign-in again:** `anchi setup service gmail` (or `drive`). Testing-mode OAuth refresh tokens commonly expire after seven days.
- **Approval refused or timed out:** the agent sees the refusal; send the task a follow-up once the cause is fixed.

## Inside the VM

`limactl shell secure-vm` opens a shell in the VM over Lima's SSH, which listens on `127.0.0.1` only, with a key in `~/.lima/_config`. You get your own user with passwordless sudo: this is the trusted side, at the level of the host administrator. Useful places:

- `sudo anchi-cell list`: the running cells.
- `sudo ls /var/lib/anchi/agents/<agent>/home`: an agent's persistent home, with its work directory and Codex and Claude sessions.
- `/var/log/anchi-egress/audit.jsonl`: the egress audit log (`anchi audit <task>` reads it for you).

Agent cells have no SSH and no interactive shell: nothing runs an SSH server in them, and they reach the network only through the egress proxy. For a look inside a running cell, `anchi-cell exec` runs one command as the agent user, without input:

```bash
limactl shell secure-vm -- sudo anchi-cell exec <task> -- /bin/sh -c 'ls -la; env | sort'
```

A cell lives until 10 minutes after its task's last turn; after that, look in the agent's home instead.

As root in the VM:

- Treat an agent's files as untrusted: do not run its scripts or source its configuration as root.
- Do not restart `anchi-egress` or other services, or run `anchi-cell reap`, while tasks run: like installing, it cuts their cells off.
- Do not paste credentials into the VM's shell; they go to the vault through `anchi setup` or the TUI (Runtimes, Connectors).

## Linux

The target is x86_64 Ubuntu 22.04+ or Debian 12+ with CPU virtualization and `/dev/kvm`. Arch and Fedora are not covered by CI; the KVM CI environment uses Ubuntu 24.04.

1. Install QEMU yourself: Debian/Ubuntu `sudo apt-get install -y qemu-system-x86 qemu-utils`, Arch `sudo pacman -S --needed qemu-base`, Fedora `sudo dnf install -y qemu-system-x86 qemu-img`. If `/dev/kvm` is not readable and writable, run `sudo usermod -aG kvm "$USER"` and log in again.
2. Install Lima from its [release page](https://github.com/lima-vm/lima/releases) and verify the published SHA-256; the CI workflow pins version 2.2.0.
3. Install Python 3.11+, install the app above, then follow First use from step 2; `setup install` stops early if `/dev/kvm` or QEMU is missing. The master key is in `~/.config/secure-vm/vault.key` and the VM in `~/.lima/secure-vm`.

Differences from macOS:

- **Codex login:** run `codex login` on this machine; Anchi reads `~/.codex/auth.json` as on the Mac. Codex must store its login in that file, not in a keyring.
- **Notifications** use `notify-send` (Debian/Ubuntu `libnotify-bin`); without it they are skipped.
- **Google sign-in** opens the browser with `xdg-open` and also prints the URL. Google redirects to a port on `127.0.0.1`, so the browser must run on the same machine; over SSH, forward the printed port or sign in on a desktop session.
- **`anchi daemon install`** writes a systemd user unit (`~/.config/systemd/user/anchi-daemon.service`). To keep it running after you log out, run `loginctl enable-linger "$USER"`.
- **Workspaces** (`~/AnchiWorkspaces`) are macOS only until the Linux mount is verified.
