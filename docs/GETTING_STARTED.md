# Getting started

macOS on Apple Silicon is supported; Linux x86_64 is experimental. Anchi runs from a checkout of this repository: there is no packaged app.

## macOS

1. Install the prerequisites: `brew install lima node pnpm python`. Keep at least 8 GB of free disk; the VM uses 4 GB of RAM and up to 30 GB of dynamically allocated disk.
2. In the checkout, install the workspace and the whole system:

   ```bash
   pnpm --dir anchi install
   scripts/anchi setup install        # VM, trusted services, agent team, base image; several minutes
   ```

   `setup install` runs `scripts/up.sh` (VM without host mounts, trusted services), `scripts/install-anchi.sh` (egress proxy, cell manager, cell runner) and the base image build. It is safe to run again to update.
3. Create and unlock the vault:

   ```bash
   scripts/anchi setup vault init     # first time: creates ~/.config/secure-vm/vault.key
   scripts/anchi setup vault unlock   # after each VM start
   ```

   Back up `vault.key`. A replacement key cannot decrypt the stored accounts, and Anchi refuses to generate one while encrypted data exists.
4. Connect a runtime. Codex: run `codex login` on the Mac, then `scripts/anchi setup codex`. Claude Code: run `claude setup-token`, then `scripts/anchi setup claude` and paste the token. Only short-lived or dedicated tokens go to the vault, through stdin; refresh tokens stay with the CLIs on the Mac.
5. Check the isolation: `make verify-anchi` (no credentials are used).
6. Open the TUI with `scripts/anchi`, select **Agent builder** and describe your first agent, or follow the [agent team guide](AGENT_TEAM.md).

The TUI's **Runtimes** screen does steps 2–4 too (`I` install, `s` start the VM, `u` unlock, `i` Codex, `c` Claude), and **Connectors** connects GitHub, AWS, Linear, Gmail, Drive, Notion and Slack. `scripts/anchi daemon install` starts the daemon at login.

Model calls consume your subscription quota. Anything an agent reads can reach the model and, through the proxy, any public host.

## Recovery

- **Installation failed:** check networking and disk space, then run `scripts/anchi setup install` again. Completed steps are reused; workspaces and credentials are kept.
- **Interrupted installation:** run it again. Installer-marked incomplete root filesystems are kept as `rootfs-incomplete-*` before rebuilding; unmarked ones are never modified automatically.
- **Stopped VM:** `scripts/anchi setup vm`, then `scripts/anchi setup vault unlock`.
- **Vault cannot unlock:** restore the original master key.
- **Expired Codex token:** run `codex` on the Mac once, then `scripts/anchi setup codex` again.
- **Google requires sign-in again:** `scripts/anchi setup service gmail` (or `drive`). Testing-mode OAuth refresh tokens commonly expire after seven days.
- **Approval refused or timed out:** the agent sees the refusal; send the task a follow-up once the cause is fixed.

## Linux

The target is x86_64 Ubuntu 22.04+ or Debian 12+ with CPU virtualization and `/dev/kvm`. Arch and Fedora are not covered by CI; the KVM CI environment uses Ubuntu 24.04.

1. Install QEMU yourself: Debian/Ubuntu `sudo apt-get install -y qemu-system-x86 qemu-utils`, Arch `sudo pacman -S --needed qemu-base`, Fedora `sudo dnf install -y qemu-system-x86 qemu-img`. If `/dev/kvm` is not readable and writable, run `sudo usermod -aG kvm "$USER"` and log in again.
2. Install Lima from its [release page](https://github.com/lima-vm/lima/releases) and verify the published SHA-256; the CI workflow pins version 2.2.0.
3. Install Node 22+, pnpm and Python 3.11+, then follow the macOS steps from step 2. The master key is in `~/.config/secure-vm/vault.key` and the VM in `~/.lima/secure-vm`.
