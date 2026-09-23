# Getting started with Anchi and Pi

macOS on Apple Silicon is supported; Linux x86_64 is experimental. Current builds are internal development packages. Public macOS distribution still requires Developer ID signing and notarization.

The desktop opens in English by default. Use the language button beside the sidebar expand/collapse control to switch between English and Simplified Chinese. The choice is saved locally and applies to pages, status messages, token entry and confirmation dialogs. Chat content and full approval payloads retain their original language.

## macOS: from launch to the first task

1. Open `Anchi.app`. It starts on First-time setup. Select Recheck to inspect actual readiness.
2. If Homebrew is missing, open its installer download page and install the official `.pkg` through the macOS installer. Do not enter an administrator password into Anchi.
3. Select Install dependencies and confirm installation of Lima, Python and Codex CLI. This requires networking; Homebrew may first need system developer tools. macOS handles system permission prompts.
4. Select Install Pi. The app creates a VM without host mounts, an isolated cell and trusted services, then installs the pinned Pi version. The VM uses 4 GB RAM and up to 30 GB of dynamically allocated disk. Keep at least 8 GB free before installation and leave the app open while it runs.
5. Select Initialize / Unlock. First use creates `~/.config/secure-vm/vault.key`; existing keys are reused. Back up this file: a replacement key cannot decrypt existing accounts. Unlock again after restarting the VM.
6. Select Sign in / Reauthenticate and complete Codex ChatGPT subscription login in the system browser, or import an existing Codex login. Only the short-lived access token is imported through stdin into the encrypted VM vault; the refresh token stays on the host. Setup shows expiry. Reimport or sign in again after expiry without disconnecting Pi. Never paste a token into chat.
7. Connect Pi, wait for the connected state, then start the example task. It turns three fictional project statements into a task list without requiring mail or directory access.
8. Model calls use standing authorization by default, so the example runs directly and is audited. If you changed model calls to per-turn approval in the setup page's fourth section, open Approvals, refresh from the policy service, inspect the full action and approve it. In that mode, the model is not called before approval.
9. Return to Agent for the result. First-task completion requires both a text reply and successful completion for the same session and turn. Then connect accounts or grant directories as needed under Connectors. Directory grants persist until revoked; overwritten or deleted files remain recoverable in the directory's hidden `.anchi-trash`.

Model calls may consume subscription quota. Files or mail already read can enter model context. The example starts a new session to avoid inheriting old context.

## Recovery

- **Installation failed:** check networking and disk space, then retry the same step. Completed base setup can be reused without deleting workspaces or credentials.
- **Interrupted installation:** reopen, recheck and retry. Installer-marked incomplete root filesystems are preserved as `rootfs-incomplete-*` before rebuilding. Unknown, unmarked root filesystems are not automatically modified.
- **Closing during installation:** normal close is blocked while installation runs. Browser-login waits can be cancelled. After forced termination or shutdown, use the retry flow.
- **Stopped VM:** start it and unlock the vault; reinstalling Pi is unnecessary.
- **Vault cannot unlock:** restore the original master key. The app refuses to generate a replacement when encrypted data already exists.
- **Expired model authentication:** sign in or import the existing Codex login again; Pi can remain connected.
- **Gmail requires reauthentication:** reconnect Google. Testing-mode OAuth refresh tokens commonly expire after seven days.
- **Directory changed or inaccessible:** check whether it moved, was replaced or is on an unmounted disk, then reconfirm the grant.
- **Approval denied or timed out:** resolve the cause and restart the task. New approvals are created; old ones are not silently reused.

References: [Homebrew installation](https://docs.brew.sh/Installation), [OpenAI authentication](https://developers.openai.com/zh-Hans/docs/auth). Organization restrictions on login or credential caching are respected; the app reports failure rather than bypassing them.

## Linux

The target is x86_64 Ubuntu 22.04+ or Debian 12+ with CPU virtualization and `/dev/kvm`. Arch and Fedora receive package-manager-specific commands but are not covered by CI. The recorded KVM CI environment used Ubuntu 24.04 and QEMU 8.2. Reserve 4 GB RAM, up to 30 GB dynamic VM storage and at least 8 GB free disk before setup.

1. Extract `Anchi-linux-x64.tar.gz` and run `Anchi-linux-x64/Anchi`. If unprivileged user namespaces are disabled and Electron reports a sandbox error, run `sudo chown root Anchi-linux-x64/chrome-sandbox && sudo chmod 4755 Anchi-linux-x64/chrome-sandbox` once. Do not bypass the sandbox with `--no-sandbox`.
2. In setup step 1, select Download Lima and Codex. Pinned, SHA-256-verified files install into `~/.local/share/anchi/tools` without administrator access. Failed verification installs nothing.
3. Run the displayed QEMU/KVM commands yourself. Debian/Ubuntu: `sudo apt-get install -y qemu-system-x86 qemu-utils`; Arch: `sudo pacman -S --needed qemu-base`; Fedora: `sudo dnf install -y qemu-system-x86 qemu-img`. If `/dev/kvm` is not readable and writable, setup also shows `sudo usermod -aG kvm "$USER"`; log out and back in afterwards. Arch commonly grants `0666` access through udev and does not need this step. Select Recheck when done.
4. Continue with the same Pi installation, unlock and login flow as macOS. Configuration is in `~/.config/Anchi`, the master key in `~/.config/secure-vm/vault.key`, and the VM in `~/.lima/secure-vm`.
5. Codex login opens the system browser. The Linux Codex binary is downloaded by the app and updated through pinned application releases.

For CLI deployment, add `~/.local/share/anchi/tools/lima/current/bin` to `PATH`, then run `bash scripts/install-pi.sh`.
