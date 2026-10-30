# Desktop app

The desktop app connects to the local daemon and saved remote daemons together. The TUI and CLI use the same daemon interfaces. Agents are listed like contacts. Each agent has a conversation in which every message starts a new task with its own runtime session. A task's transcript and replies, which continue that task's session, open in a drawer over the right side of its task list. It runs on macOS and Linux. Windows is untested: it has no local server, so there it could only use a remote one.

## Install

The installer adds the desktop app with `--desktop`:

```bash
curl -fsSL https://anchi.elseward.xyz/install.sh | sh -s -- --desktop
```

It installs the CLI as usual, then the app of the same release, after checking its SHA-256 like the CLI's archive:

- **macOS:** `~/Applications/Anchi.app` (`ANCHI_DESKTOP_DIR` picks another folder). An existing `Anchi.app` there is replaced only if its bundle id is `dev.anchi.desktop`.
- **Linux:** the app goes into the release's version directory, `~/.local/share/anchi/current/desktop`, so it always matches the CLI. The installer adds the launcher `anchi-desktop` beside `anchi`, and Anchi to the applications menu (`~/.local/share/applications/anchi.desktop`).

`anchi update` then updates the app with the CLI. The app is also a release asset of its own, `anchi-desktop-darwin-arm64.tar.gz` or `anchi-desktop-linux-x64.tar.gz`, with a `.sha256`.

The desktop checks GitHub's latest stable release at startup and every six hours, comparing it
with the version built into the desktop app (independent of the selected daemon). A newer
version opens a non-blocking notice in the bottom-right corner with **What's new**, **Copy
command** (`anchi update`) and **Remind me tomorrow**. Closing it postpones that release for
24 hours, including across restarts; a newer release can still be announced. Network failures
and API rate limits stay silent and retry on the next check. The request sends no agent,
task or account data. The notice does not download or install anything automatically.

Run the copied command in Terminal. After tasks finish, restart Anchi and follow the release
notes for daemon and VM upgrades. From a source checkout, update and rebuild the checkout
instead of using the installer-only `anchi update`.

### Upgrade a machine from the app

**Settings → Machines** shows each connected machine's Anchi version. When the latest release
is newer and the machine runs an installer-managed release (the desktop's **Initialize** or the
public installer), its row has **Upgrade to <version>**:

1. The app refuses while the machine has a running task cell or a running or queued task, and
   says so; nothing is changed.
2. A system dialog names the machine and the version change. **Upgrade** continues.
3. The app checks for tasks again, then upgrades:
   - **This computer:** `anchi update` (the CLI and an installed desktop app), `anchi daemon
     stop`, and `anchi daemon install` again only if login startup was installed. The app starts
     the new daemon when it reconnects, then offers to reopen itself.
   - **A remote machine:** over its SSH connection, a fixed script checks again that no cell runs,
     runs `anchi update`, points the systemd user service at the new version (`anchi daemon
     install`) and restarts it.
4. The app reconnects, requires the new version, and, if the VM's components were installed
   by the old version, updates them with `setup.prepare` for an already prepared runtime. This
   can take several minutes; the row says **Upgrading…** until it finishes.

The upgrade installs the latest release, checked with its SHA-256 as `anchi update` does.
Agents, task history and credentials are kept. A machine running Anchi from a source checkout
(`scripts/anchi`, `scripts/remote.sh`) gets a note instead of the button: upgrade the checkout,
and a remote one with `scripts/remote.sh <target>`. Daemons of 0.4.4 and earlier do not report
their version, so the app offers no upgrade for them; update them once by hand.

The app is not signed by a publisher, as the CLI is not; the checksums protect against corruption, not tampering. On macOS a file downloaded by the installer opens as is. An `Anchi.app` downloaded with a browser is quarantined, and macOS refuses to open it: open System Settings → Privacy & Security and choose Open Anyway, or remove the quarantine with `xattr -dr com.apple.quarantine Anchi.app`. On Apple silicon it is signed ad hoc, which only lets it run.

Opened from the Finder, the Dock or a desktop menu, an app gets a minimal `PATH`. The packaged app therefore asks the login shell for its `PATH` at start (`$SHELL -ilc`, for at most five seconds) and adds the installer's directories (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). With `local`, it starts the daemon with that `anchi`; a remote server is reached with the `ssh` or `instabox` found there.

### Linux sandbox

Electron isolates its renderer with user namespaces. Ubuntu 23.10 and later allow them only to programs an AppArmor profile permits (`/proc/sys/kernel/apparmor_restrict_unprivileged_userns` is `1`), and the installer says so. Without a profile, the app exits at start. This profile permits every installed version (not yet tried on Ubuntu):

```bash
sudo tee /etc/apparmor.d/anchi-desktop >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile anchi-desktop @{HOME}/.local/share/anchi/versions/*/app/desktop/anchi-desktop flags=(unconfined) {
  userns,
  include if exists <local/anchi-desktop>
}
PROFILE
sudo apparmor_parser -r /etc/apparmor.d/anchi-desktop
```

Do not start it with `--no-sandbox`: the renderer shows agent text.

## From a source checkout

After `pnpm --dir anchi install`:

```bash
scripts/anchi-desktop
```

The script bundles `anchi/packages/desktop` with esbuild and starts Electron. On first use, it also fetches the Electron binary for the platform. The window initially selects the same machine as the CLI and also connects to every saved machine:

- `ANCHI_SERVER`, else the choice saved by `anchi server <target>`, else `local`.
- With `local`, it starts the local daemon through `scripts/anchi daemon start` when none is running. Set `ANCHI_CLI` to use another CLI.

The machine button at the bottom of the left rail shows the number of connected machines and opens Settings → Machines. In Settings, select a machine card under **Machines** to configure it. Builder, Approvals and Usage have a styled machine selector; an agent view follows the machine of the selected agent. Team groups agents under machine headings; each row shows a runtime tag below the agent's name, and the selected agent's header identifies its machine. Below the tag, the agent's state or its latest task title is shown as a one-line quote, so every row has the same height; a longer one is cut with an ellipsis and shown in full on hover. The quote's rule is amber while an approval waits and red after an error. When the selected machine is offline, a banner says why and task actions are unavailable. The app keeps its window state, such as the task panel's width, in its own profile: `~/Library/Application Support/Anchi Desktop` on macOS, `~/.config/Anchi Desktop` on Linux. macOS takes an app's name in the menu bar, the Dock and Activity Monitor from its bundle, so on macOS `build.mjs` keeps a copy of Electron.app as `dist/Anchi.app` (name, bundle id `dev.anchi.desktop`, executable and icon changed, signed ad hoc) and `scripts/anchi-desktop` starts that. The copy is made again only when Electron or the icon changes.

## Getting started

In **Settings → Machines**, adding a remote server without Anchi offers a native **Initialize**
dialog. It installs the matching published Linux x86_64 release and starts the daemon through
SSH, then opens the existing preparation guide. The packaged app includes the setup resources;
no source checkout is required. A saved machine with a missing bridge shows **Initialize** so
you can resume later. See [remote requirements and data locations](REMOTE_SERVER.md#set-up-a-server).

The window opens Getting started for each server it has not finished the guide for, unless that server already has a ready runtime, an agent and a finished task: switching to a new server opens it again, once per window. The guide has four stages, and Settings → Getting started opens it again:

1. **Where Anchi runs:** this computer or a saved remote server (see Settings → Machines). When the server in use cannot be reached, the button says so instead of waiting. On a remote server the guide starts at the next stage.
2. **Prepare the environment:** lists missing host tools with the command that installs them; otherwise Prepare runs `setup.prepare` for the suggested runtime (start or install the VM, its services and the runtime image, unlock the vault) and shows its output. A system dialog asks first and says to back up the vault key.
3. **Connect a runtime:** the runtime cards of Settings. Codex imports the login of the machine the daemon runs on; when it has none, the card names what to run there (`codex login`, or on a remote server `instabox ssh <machine>` or `ssh <host>` followed by `codex login --device-auth`).
4. **Meet your first agent:** creates `@dev` (no connectors, no workspaces) on the suggested runtime, then offers three starter tasks; choosing one opens the agent's conversation.

Skip for now leaves the guide until it is opened again.

## What it does

The Team list discovers agents on all connected machines without copying their profiles or granting new delegation permissions. Same-name agents remain separate. Offline machines keep their last known agent list for this desktop session, marked offline.

A working agent's avatar has a small, pale green dot orbiting it every 2.8 seconds, with no
ring or glow. Adjacent rows start at different positions to keep a busy team visually quiet.
The dot stops when work finishes or the machine disconnects; waiting approvals, queued work
and errors keep their own status dots and text. The system's reduced-motion preference keeps
the working dot stationary.

Click a host heading in Team to collapse or expand its agents; Enter or Space also toggles a
focused heading. Its agent count and connection status remain visible when collapsed. Each
host starts expanded and remembers your choice across navigation and app restarts, keyed by
its connection target. Collapsing a host keeps its connection, running tasks and the open
agent view intact.

For coordinated delegation across machines, select the team coordinator in the machine selector. In **Agent builder**, select a
saved node under **Run on** and name an existing agent there, then review and apply the new
member. No model call is needed. The member and task headers show its execution location;
remote results, delegated work, usage and approvals appear with the local team's. Remote
member settings show the binding and delegation grants; runtime and access settings are
managed on the execution node. Node aliases must be saved on the coordinator. See
[One team, multiple execution nodes](REMOTE_SERVER.md#one-team-multiple-execution-nodes).

| Area | What you can do |
|---|---|
| Team | Pick an agent from any connected machine; its tasks read as a conversation. The box under it starts a new task in a new session; nothing carries over from the tasks above. User messages and result cards use the same wider limit and balanced side spacing. Each card shows the status, the folded tool calls, what the agent is doing, and the result, with delegated tasks as chips. Task details start closed: click anywhere on a task card to slide its conversation in from the right; buttons and links in the card keep their own action, and selecting text does not open it. The header says **Details ›** while the task runs and **Continue this task ›** once its turn has ended, in which case the drawer opens with the cursor in its reply box. Click the header again, use Close or press Esc to slide it out. The drawer overlays the list without resizing it, and its left edge remains resizable. Hiding and reopening the same task preserves an unsent reply. |
| Agent settings | The Settings tab beside an agent's conversation edits its name, description, runtime, model, reasoning effort, system prompt (added to or replacing the template's), skills, connectors, delegation recipients and workspaces. Review changes shows the change to the agent file, with its errors and warnings; Apply writes it, and is refused if the file changed since the review. High-risk operations (merging a pull request, pushing to the default branch and the others in the agent's connectors) can be let through without approval for this agent. Settings only the agent file sets (template, image, sandbox, triggers, approvals, egress) are shown read-only. |
| Task panel | The selected task's time, turns and tokens, delegated work, full transcript, a reply that continues its session, and Cancel, Retry or Start over. Drag its left edge, or focus the edge and use the arrow keys, to resize it; a double-click restores the default. The conversation keeps at least 360 pixels. The width is remembered on this computer. |
| Agent builder | One conversation with the builder, or an empty starter (agent id and runtime) with no model call. A proposal opens in a panel the app draws from the proposed file, with its diff, errors and warnings; Apply writes it, Discard drops it. |
| Approvals | Held writes appear inside the task's card and in the Approvals view. Each shows the connector, operation, reason, origin chain, the full summary and a countdown, then Deny and Approve. A write left waiting is refused when its time runs out. |
| Usage | Select a machine to see its usage. Subscription windows per runtime, and token totals by agent, model, runtime or day over 24 hours, 7 or 30 days. |
| Settings | Machines (`local` and the saved remote servers of `anchi server ls`: connect several together, configure one, add an instabox machine or any SSH host under a name, or forget one), environment, runtimes, proxy connectors (token connect and disconnect), service connectors (browser sign-in for Gmail, Drive, X and Reddit, a token for Notion and Slack, disconnect, auto or ask writes) and skills. The selected machine card scopes environment, runtime, connector, service and skill cards and all their actions. Switching machines closes open credential forms and clears the previous machine's configuration view; credentials are never copied between machines. Each runtime shows Connected or Not set up with a Set up or Replace button: Codex imports the server machine's `codex login`, Claude Code takes a token or API key, Hermes takes a base URL, model and API key. Connectors and services are listed by name with the service's mark, here and in an agent's Settings tab; the marks are bundled Simple Icons paths, and AWS, Firecrawl and Slack, which Simple Icons does not carry, show their initial. A connector's token, Notion's or Slack's included, like a runtime's credentials, is typed in a form that opens under its row; Escape closes it. The form says where the token comes from. A connector that is not connected links to its setup guide (**How to connect ↗**), a section of [Connectors](CONNECTORS.md), through `https://anchi.elseward.xyz/docs/connect/<name>`. Gmail, Drive, X or Reddit without the OAuth app their sign-in needs link the guide as **Needs an OAuth app ↗** and offer **Add app** instead of **Sign in**: Google's client JSON is chosen in a system file dialog and read by the app, not the window, and X and Reddit take the app's Client ID (Reddit also the developer username). **Sign in** appears once the server has the app. A service's Disconnect asks first in a system dialog that says whether the provider revokes the credential too; Gmail and Drive list each account on its own row, and an account or service whose remote revocation is still pending offers Revoke again. Skills are added from a GitHub address (pinned to its current commit), or, with the local server, from a folder chosen in a system file dialog; Check for update shows the newer commit and the files it changes before Update installs it; Remove asks in a system dialog that names the agents still listing the skill. |

Saved machines connect automatically when the app opens and retry independently after connection failures. A missing bridge waits for **Initialize** instead of retrying. **Disconnect** closes only that desktop connection for the rest of the session (until **Connect** or reopening the app); it does not stop the daemon or its tasks. Removing a saved machine closes its connection and removes its rows. The selected machine is remembered as the CLI server choice.

Approvals and Usage show the selected machine's records. The rail approval count includes all machines; use the machine selector to review another machine. Coordinator approvals and usage already include delegated work, so execution-node records are not summed into them.

The app does not:

- delete individual tasks;
- run single setup steps (`setup.run`) or reset;
- stop the daemon;
- import AWS credentials.

Use the TUI or CLI for these.

To delete an agent, open its **Settings → Delete agent…**, review the affected data, type its
exact id and choose **Continue to confirmation**. A native dialog names the agent and machine
before deleting its configuration, task history (including delegated tasks), triggers and VM
home, sessions, skills and policy. Active tasks are cancelled. Workspace directories and audit
logs are retained. The dialog remains open to report partial cleanup and offers another review
when cleanup must be retried. The built-in builder is protected.

A saved server needs an updated daemon to edit delegation. Older daemons show the allowlist read-only with an upgrade message. The recipient picker lists agents on that machine, excludes the source agent and preserves missing recipients until you remove them. For a team member running elsewhere, edit its coordinator allowlist here and the execution profile’s allowlist on its own machine.

## Boundaries

- **Main process:** the Electron main process holds one connection per machine: the local socket and `anchi-bridge` over SSH for a remote server.
- **The window:** it is sandboxed, with context isolation, no Node integration, a content security policy that loads nothing from the network, no navigation and no new windows.
- **Calls from the window:** it reaches the main process through a narrow preload API. Every daemon call and notification carries a machine target registered in the main process; unknown or disconnected targets are refused without falling back to another daemon. Native file pickers and confirmation dialogs pin the original connection; disconnecting or reconnecting it while the dialog is open refuses submission. Confirmation dialogs name the machine. Daemon methods outside `DESKTOP_METHODS` (`packages/desktop/src/main/bridge.ts`) are refused there, which includes individual task deletion, reset and daemon shutdown. Agent deletion is explicitly allowed only through its typed-id and native-confirmation flow.
- **Confirmations the window cannot give:** an agent settings change that gives the agent a new delegation recipient, a new connector, a new workspace or write access to one is confirmed in a system dialog from the main process, which compares the change with the agent's current settings. Cancel there, and the change never reaches the daemon. Removing a skill, preparing the environment (`setup.prepare`), a new high-risk exemption, and letting X or Reddit post without asking are confirmed the same way; the X and Reddit dialog says that agents would then post publicly under the account, also from triggered tasks reading untrusted content. The window adds skills only from `https://github.com/` addresses; a folder on this computer comes from a system file dialog the main process opens, and only for the local server, since a remote server would read the path on its own disk.
- **Locked vault:** after the server or VM restarts, a banner says the vault is locked and its credentials are still stored, and Settings shows **Unlock the vault** in place of the runtime, connector and service cards. Unlocking goes through `setup.prepare`, whose system dialog asks **Unlock the vault?** when that is all it does.
- **Agent text:**
  - It is sanitized: control characters, terminal escapes and bidirectional overrides are removed.
  - Its Markdown is drawn as React elements, never as HTML: headings, paragraphs, lists (nested, and numbered from their first number), tables with column alignment (a wide one scrolls sideways; columns past 30 are dropped), quotes, horizontal rules, fenced code, bold, italics, strikethrough, inline code and web links. Quotes and lists stop nesting eight levels deep.
  - A link opens the system browser only for an `http` or `https` address, and its address is shown as its tooltip.
- **Trusted panels:** builder proposals and approvals are drawn by the app from the daemon's records, under a dark band that agent text cannot produce.
- **Secrets:** a connector or service token typed in Settings goes to the main process and then to the daemon. From there it travels as the CLI's does: into the vault on stdin.

## Checks

```bash
pnpm --dir anchi exec vitest run packages/desktop
node anchi/packages/desktop/scripts/drive.mjs steps.json [profile-dir]   # after a build; see the script's header
```

Release packages (on the platform they are for, after `scripts/package-release.sh`):

```bash
node anchi/packages/desktop/scripts/package.mjs
python3 scripts/check-desktop-release.py artifacts/releases/anchi-<target>.tar.gz artifacts/releases/anchi-desktop-<target>.tar.gz
```

`package.mjs` writes `artifacts/releases/anchi-desktop-<target>.tar.gz`: on macOS a copy of `dist/Anchi.app` with the app code in `Contents/Resources/app` and the release version, signed ad hoc again; on Linux Electron's directory with the executable renamed `anchi-desktop`. `check-desktop-release.py` installs it with the public installer through a stand-in `curl`, checks refusals (another app's `Anchi.app` or `anchi-desktop`, a bad checksum) and `anchi update`, then opens the installed app with a minimal `PATH` and waits until it has started the daemon and connected. On Linux it needs `xvfb-run`; `.github/workflows/release.yml` runs it on both platforms.

`scripts/drive.mjs` starts the built app with a debugging port. It then clicks, types, evaluates and takes screenshots from a JSON list of steps, and prints the page's errors. It runs the app in a profile of its own, a new temporary one unless you name a directory, so it does not share storage with an open Anchi window. `ANCHI_DRIVE_APP=<executable>` drives a packaged app instead of the checkout's build. On a Linux machine without a display, run it under `xvfb-run`.

## Limits

- **Live checks:** the app was tried against a local daemon on macOS, a remote instabox server from macOS, and a daemon on Debian 13 under Xvfb. The release packages were installed, updated and opened on macOS and on Debian 13 under Xvfb; the AppArmor profile above was not tried on Ubuntu. Approvals were not tried live; they are covered by unit tests.
- **Windows:** has no local server, and is untested.
- **Session state:** new events arrive while the app runs. A reconnection reads agents, tasks and approvals again; transcripts load when their task opens. A builder proposal made while the app was closed does not appear in it: ask the builder to propose it again.


### Peer team networking

Under **Settings → Machines**, choose the machine to configure; **Peer team** below it configures
that daemon's reachable TLS address and joins a trusted member. Configure both machines before
joining. Native confirmations describe the authority granted to the other daemon. Once paired,
members discover one another without keeping this desktop app or the first machine online.
See [Equal peer teams](REMOTE_SERVER.md#equal-peer-teams) for network prerequisites.

Team groups discovered agents by machine and prefers a direct connection when one is available.
You can submit tasks through a discovered member. Its Settings tab explains which machine owns
its configuration; connect to that machine to edit it. Delegation choices display agent and
machine labels, including offline members. No delegation permission is added by joining alone.
