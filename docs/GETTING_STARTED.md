# Getting started

Anchi runs in one of two placements:

| Placement | Where | What you get | Guide |
|---|---|---|---|
| Host placement (the default on your computer) | Your macOS or Linux machine, no VM | Anchi's egress proxy, vault and approvals for your own `claude` and `codex` sessions, under their runtimes' own sandboxes | [Host placement](HOST_PLACEMENT.md) |
| Remote server | A Linux server (Debian or Ubuntu, for example an instabox VM) that is the guest | The agent team: agents in disposable task cells, triggers, delegation and teams | [Remote server](REMOTE_SERVER.md) |

On your computer, the daemon starts as the host placement unless `ANCHI_GUEST=local` is set; agent tasks are refused there and need a remote server. This page covers installing Anchi on your computer, preparing the host placement and reaching a remote server from it.

| Host | Status |
|---|---|
| macOS on Apple Silicon | Supported |
| Linux x86_64 with glibc (Ubuntu 22.04+ / Debian 12+) | Experimental |

Arch, Fedora and other distributions may work but are not covered by CI.

Choose one way to install:

| | Binary release | From source |
|---|---|---|
| For | Using Anchi | Developing or testing unreleased changes |
| Needs | `curl` | Git, Node 22+, pnpm |
| Open | Anchi desktop app; `anchi` for the TUI | `scripts/anchi-desktop`; `scripts/anchi` for the TUI |
| Updates | `anchi update` | `git pull`, then reinstall dependencies |

The host placement needs the `openssl` command line on `PATH` (macOS ships it; Debian and Ubuntu have the `openssl` package). Nothing else has to be installed before Anchi: the release bundles its own Node, and the host needs no Python.

## Install the binary release

The release installer downloads Anchi and its bundled Node runtime, verifies the archive's
SHA-256 checksum, and installs the desktop app and an `anchi` command with `--desktop`.
Git, Node and pnpm are not required. It does not need sudo or modify your vault or agents.

### macOS

1. Install the app:

   ```bash
   curl -fsSL https://anchi.elseward.xyz/install.sh | sh -s -- --desktop
   ```

2. If the installer says your bin directory is missing from PATH, open a new terminal or run
   the `export PATH=…` line it prints.
3. Open `~/Applications/Anchi.app` and follow [guided desktop setup](#guided-setup-in-the-desktop-app).

### Linux

1. Install the app:

   ```bash
   curl -fsSL https://anchi.elseward.xyz/install.sh | sh -s -- --desktop
   ```

2. If the installer says your bin directory is missing from PATH, open a new terminal or run
   the `export PATH=…` line it prints.
3. Open **Anchi** from the applications menu or run `anchi-desktop`, then follow
   [guided desktop setup](#guided-setup-in-the-desktop-app). Ubuntu 23.10 and later need the
   [desktop sandbox profile](DESKTOP.md#linux-sandbox).
4. Optionally install `notify-send` for desktop notifications (Debian/Ubuntu `libnotify-bin`,
   Arch `libnotify`); without it notifications are skipped.

### Installer options

The installer configures your shell for future sessions; a script piped into `sh` cannot change
the parent terminal's environment.

- The commands above install both the desktop app and CLI. `anchi update` updates both.
  See [Desktop app](DESKTOP.md#install).
- For a server or terminal-only installation, omit `--desktop`:
  `curl -fsSL https://anchi.elseward.xyz/install.sh | sh`. Run `anchi` to open the TUI.
  Re-run the installer with `sh -s -- --desktop` to add the GUI later.
- Install a specific release with
  `curl -fsSL https://anchi.elseward.xyz/install.sh | ANCHI_VERSION=v0.5.0 sh -s -- --desktop`.
- `ANCHI_INSTALL_ROOT` overrides the default `~/.local/share/anchi`.
- `ANCHI_BIN_DIR` overrides the command directory. By default the installer prefers a writable
  `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin` already on PATH, falling back to
  `~/.local/bin`.

## Install from source

A source checkout runs the TypeScript sources directly through `scripts/anchi`. Use
`scripts/anchi` wherever this guide says `anchi`.

### macOS

1. Install the prerequisites:

   ```bash
   brew install git node pnpm
   ```

   Node must be 22 or newer (`node --version`); `.nvmrc` names the version CI uses. Python 3.11+
   is needed only for the [development checks](#development-checks).
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

4. Continue with [Set up your computer](#set-up-your-computer), running `scripts/anchi` from
   the checkout.

### Linux

1. Install Git and Node 22+ with your package manager or a version manager such as nvm or
   mise. `.nvmrc` names the Node version CI uses. Python 3.11+ is needed only for the
   [development checks](#development-checks).
2. Install pnpm. Node 25 and newer no longer bundle corepack, so install pnpm directly with one of:

   ```bash
   npm install -g pnpm                # any Node install
   mise use -g pnpm                   # if mise manages your Node
   corepack enable pnpm               # Node 22–24 only
   ```

   `anchi/package.json` names the pnpm version the project pins in `packageManager`.
3. Clone the repository and install the workspace dependencies:

   ```bash
   git clone https://github.com/jwfing/anchi.git
   cd anchi
   pnpm --dir anchi install
   ```

   If `scripts/anchi` later fails with `Cannot find module …/node_modules/tsx/dist/loader.mjs`,
   this step has not run.
4. Check that the launcher starts:

   ```bash
   scripts/anchi --help
   ```

5. Continue with [Set up your computer](#set-up-your-computer), running `scripts/anchi` from
   the checkout.

### Development checks

The offline checks need a Python virtual environment with the test dependencies:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
make check PYTHON=.venv/bin/python
```

`make check` does not access a guest, an account or a model. On a remote server with the guest
installed, `make verify-guest` and `make verify-anchi` run the live isolation checks there (no
credentials used); `scripts/verify-host.sh` is the host placement's live check.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for the daily workflow.

### Update a source checkout

```bash
git pull
pnpm --dir anchi install
scripts/anchi setup install    # on a remote server, when the change touches the guest, services or cell runner
```

`anchi update` does not modify a checkout.

## Set up your computer

These steps are the same for both installation methods and both platforms. From a source
checkout, replace `anchi` with `scripts/anchi`. They prepare the host placement; to run agents,
set up a [remote server](REMOTE_SERVER.md) and choose it with `anchi server <name>` or in the
desktop app's **Settings → Machines**, then prepare that machine the same way.

### Guided setup in the desktop app

Open **Anchi** and follow **Getting started** to choose a machine, prepare its environment and
connect a runtime. On this computer, **Settings → Security & recovery** shows the card **This
computer, no secure room** with **Enable** and **Disable** for your own `claude` and `codex`
sessions ([Host placement](HOST_PLACEMENT.md)). On a remote server, review a starter agent, then
select an agent in **Team** and send a task. Click a task to open its conversation and results.
Use **Agent builder** to create more agents; **Settings** configures each machine's runtimes,
connectors, services and skills. See [Desktop app](DESKTOP.md) for the full guide.

### Guided setup in the TUI

Run `anchi`. First launch opens **Getting started**:

1. **Prepare your environment.** Anchi detects installed Codex and Claude Code CLIs and
   usable local subscription logins. With a detected login, Anchi skips runtime selection; when
   both are present, it imports both and prepares Codex by default. Without a usable login,
   choose a runtime. Confirm once to start the services, initialize or unlock credential
   storage and, on a remote server, install the guest's components and prepare the runtime
   image. Completed steps are reused on retry. No model is called. Back up
   `~/.config/anchi/vault.key`; existing keys are never replaced.
2. **Connect your account automatically.** Once the vault is ready, Anchi imports available
   Codex and Claude Code access tokens without a separate account selection or import dialog.
   Codex uses `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`). Claude Code uses the macOS
   Keychain, with `.credentials.json` as a fallback, or `~/.claude/.credentials.json` on Linux;
   `CLAUDE_CONFIG_DIR` selects another configuration directory. macOS may ask for Keychain access.
   Refresh tokens stay on the host. If no usable login exists, sign in locally or use the
   manual runtime dialog; Hermes still needs an endpoint, model and key.
3. **Review your starter and try a task** (remote server only). Press **Enter** to review `dev`
   with a connected runtime, then **y** to save. The input contains a small sample code-review
   request: edit it or press **Enter** to review it, then **Enter** to send. Only sending calls
   a model.

**Ctrl+X, L** shows preparation logs and **Ctrl+X, !** opens persistent error details and a
retry action. **Ctrl+X, N** chooses a custom agent name and runtime. The CLI preparation
equivalent is:

```bash
anchi setup prepare                    # use the detected login; review and confirm
anchi setup prepare --runtime claude-code  # explicitly choose a runtime
```

`--yes` skips the confirmation. Preparation also imports available local logins. Anchi checks
refreshed logins on file changes and every five minutes. Existing manual Claude tokens/API keys
are kept. Set `codexAutoImport: false` or `claudeAutoImport: false` in `~/.anchi/settings.yaml`
to disable that runtime's automatic import.

On a remote server, release installations download prebuilt base and selected runtime layers.
Their SHA-256, architecture and recipe compatibility are checked against the manifest bundled
in the app before extraction. A failed download or verification stops preparation and can be
retried; it does not silently switch to a local build. Source checkouts and locally packaged
apps without a prebuilt manifest build the layers locally.

Any one connected runtime is enough: Agent builder runs on the
first connected of Codex, Claude Code and Hermes (`builderRuntime` in `~/.anchi/settings.yaml`
picks one). Teams with setup and a first task complete open on **Team overview**;
**Ctrl+X, 0** reopens the guide.

### Step by step

1. **Start the services and initialize the vault.** On this computer the services (the proxy
   and the vault) start with the daemon; `anchi setup start` (or `s` in **Runtimes**) starts
   them again if they stopped. On a remote server, install the guest's components first, in
   **Runtimes** with `I`, or:

   ```bash
   anchi setup install          # remote server: asks for confirmation; add --yes to skip it
   ```

   Installation installs the trusted services and prebuilt cell runners and builds the base
   image (from the release or a local build). It takes several minutes and can be rerun to
   update; completed steps are reused.
2. **Initialize and unlock the vault:**

   ```bash
   anchi setup vault init       # first time only
   anchi setup vault unlock     # after the services restarted
   ```

   The master key is `~/.config/anchi/vault.key`. Back it up; a replacement key cannot
   decrypt stored accounts.
3. **Connect a runtime.** These operations are also available in **Runtimes**.
   - Codex: `anchi setup codex --sign-in` (or **g** in Runtimes, **Sign in with ChatGPT** in the
     desktop app) prints a page and a one-time code: open the page in any browser, sign in to
     ChatGPT and enter the code. Anchi downloads the Codex CLI it pins for this, keeps the login in
     `~/.anchi/codex` and refreshes it; the Codex CLI does not need to be installed. Alternatively,
     with the Codex CLI installed and `codex login` run on this machine, `anchi setup codex`
     imports `~/.codex/auth.json`; Codex must store its login in that file, not in a keyring.
   - Claude Code: `anchi setup claude --sign-in` (or **C** in Runtimes, **Sign in with Claude**
     in the desktop app) opens Claude's sign-in page; once you sign in, Anchi stores a one-year
     subscription token. It downloads the Claude Code it pins for this; Claude Code does not need
     to be installed. For a remote server, the page shows a code to paste back. Alternatively,
     sign in to Claude Code locally for automatic import, or run `claude setup-token`, then
     `anchi setup claude` and paste the token.
   - Hermes: `anchi setup hermes --base-url https://openrouter.ai/api/v1 --model <model>` and
     paste the endpoint's API key (or **h** in Runtimes). Any OpenAI-compatible API works; the key
     stays in the vault.

   On the host placement your own sessions keep their own logins; the runtimes connected here
   are for agents on a remote server. Guided preparation installs the selected runtime before
   the first task. With the manual steps here, its image is installed on first use; runtimes
   you never select or use are not downloaded.
4. **Use the host placement, or create an agent.** On this computer, `anchi host enable`
   writes Claude Code's and Codex's sandbox settings so your own sessions go through Anchi's
   proxy ([Host placement](HOST_PLACEMENT.md#set-up)). On a remote server, continue in
   **Getting started**, or press **Ctrl+X, N**, choose your connected runtime and name the
   agent. Review the YAML and press **y** to save. The CLI equivalent (substitute your
   connected runtime) is:

   ```bash
   anchi agents create dev --runtime claude-code
   anchi run dev "Explain what tools you have access to. Do not change anything."
   anchi tasks --agent dev
   ```

   The starter has no connectors, shared folders or extra network destinations. Creation
   calls no model; the task does. Expect a response and a `done` status. See [First task](FIRST_TASK.md)
   for recovery and next steps. Use **Agent builder** for a custom role with any connected runtime.
5. **Optionally start the daemon at login:** `anchi daemon install`. On macOS this is a launch
   agent; on Linux a systemd user unit (`~/.config/systemd/user/anchi-daemon.service`). To keep
   it running on Linux after you log out, run `loginctl enable-linger "$USER"`.

Model calls consume your subscription quota. Anything an agent reads can reach the model
and any destination its configuration permits; omitting `egress` allows public Internet access.

## Linux differences

- **Notifications** use `notify-send`; without it they are skipped.
- **Google sign-in** opens the browser with `xdg-open` and also prints the URL. Google redirects
  to a port on `127.0.0.1`, so the browser must run on the same machine; over SSH, forward the
  printed port or sign in on a desktop session.
- **Claude Code's sandbox** needs `bubblewrap` and `socat` for the host placement (see its
  `/sandbox` panel). Where guides say "the Mac", read "this machine".

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
service points to the new version. On a remote server, then run `anchi setup install` once to
update the guest's components: Anchi compares the version that installed them
(`/opt/secure-vm/installed.json`) with its own, and until they match **Getting started** opens
on its environment step with **Enter** running the update, **Runtimes** shows both versions in
red with `I`, and every new task carries a notice. Older packages remain under
`~/.local/share/anchi/versions` and can be removed once no daemon or login service uses them;
`anchi update` and the installer print the removable directories with the `rm -rf` command, and
never delete them on their own.

To remove the app, first run `anchi host disable` if the host placement is enabled, then
`anchi daemon uninstall` and `anchi daemon stop`, then delete only the installed `anchi`
launcher and the install root. Your `~/.anchi` data and vault are separate and retained
(`~/.anchi/host` holds the host placement's state). Remove the installer's PATH line from your
shell config if desired.

### Start over

To return your computer to a first launch, stop the daemon (`anchi daemon stop`), run
`anchi host disable` if the host placement was enabled, then delete `~/.anchi` (or
`ANCHI_HOME`), which holds agents, templates, images, skills, `settings.yaml`, the task database,
logs and the host placement's vault and audit log, and `~/.config/anchi/vault.key` if you want a
new, empty vault. Credentials are deleted locally only; revoke them at the provider if you no
longer want them to exist (disconnect Google accounts before deleting to revoke their tokens).
A login service from `anchi daemon install` stays installed and starts the daemon again at the
next login. A remote server is reset by deleting or recreating the machine.

## Recovery

- **Installation failed (remote server):** check networking and disk space, then run `anchi setup install` again. Completed steps are reused; workspaces and credentials are kept. A step that runs longer than 45 minutes is stopped and named in the error.
- **Prebuilt layer download or verification failed:** retry preparation after checking the network and disk space. A checksum or compatibility failure never extracts the archive. Reinstall the matching app release if it persists; source installations use local builds.
- **"The guest runs but could not be asked":** a guest command failed (shown with the message in Getting started, Runtimes and `anchi setup status`); the rest of the status is unknown, not reset. Press **r** to try again; if it keeps failing, `anchi setup install` reinstalls the guest components, keeping agents and credentials.
- **Missing `openssl`:** Getting started and `anchi setup status` list it under what is missing on this computer; install it, then prepare again.
- **Installation refused because tasks are running:** installing restarts the egress proxy, which would end them. Wait for them (`anchi tasks`) or cancel them, then run it again; `ANCHI_FORCE_RESTART=1` installs anyway. `make verify-anchi` refuses for the same reason (`ANCHI_CHECK_WITH_TASKS=1` runs it beside them, leaving their cells alone).
- **Interrupted installation:** run it again. Installer-marked incomplete root filesystems are kept as `rootfs-incomplete-*` before rebuilding; unmarked ones are never modified automatically.
- **Services stopped (host placement):** `anchi setup start`, then `anchi setup vault unlock`. `anchi host status` says whether they run.
- **`VAULT_KEY_MISSING` when unlocking:** `unlock` requires an existing master key. For a new
  vault, run `anchi setup vault init` (from source:
  `./scripts/anchi setup vault init`) to create the key and unlock the empty vault. Initialization
  refuses to generate a replacement when encrypted credentials exist; restore the original key
  from backup in that case. Back up the new `~/.config/anchi/vault.key` after initialization.
- **Vault cannot unlock with an existing key:** restore the original master key.
- **Expired Codex token:** run `codex` on this machine once, then `anchi setup codex` again.
- **Google requires sign-in again:** `anchi setup service gmail` (or `drive`; add `--account <name>` for a named account). Testing-mode OAuth refresh tokens commonly expire after seven days.
- **Start from scratch:** see [Start over](#start-over).
- **Approval refused or timed out:** the agent sees the refusal; send the task a follow-up once the cause is fixed.

## Inside the guest

On a remote server, SSH in as its login user (for instabox, `instabox ssh <machine>`). You get
passwordless sudo: this is the trusted side, at the level of the host administrator. Useful places:

- `sudo anchi-cell list`: the running cells.
- `sudo ls /var/lib/anchi/agents/<agent>/home`: an agent's persistent home, with its work directory and Codex and Claude sessions.
- `/var/log/anchi-egress/audit.jsonl`: the egress audit log (`anchi audit <task>` reads it for you).

Agent cells have no SSH and no interactive shell: nothing runs an SSH server in them, and they reach the network only through the egress proxy. For a look inside a running cell, `anchi-cell exec` runs one command as the agent user, without input:

```bash
sudo anchi-cell exec <task> -- /bin/sh -c 'ls -la; env | sort'
```

A cell lives until 10 minutes after its task's last turn; after that, look in the agent's home instead.

As root on the server:

- Treat an agent's files as untrusted: do not run its scripts or source its configuration as root.
- Do not restart `anchi-egress` or other services, or run `anchi-cell reap`, while tasks run: like installing, it cuts their cells off.
- Do not paste credentials into the server's shell; they go to the vault through `anchi setup` or the TUI (Runtimes, Connectors).
