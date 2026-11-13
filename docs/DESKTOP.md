# Desktop app

The desktop app connects to the local daemon and saved remote daemons together. The CLI uses the same daemon interfaces. Agents are listed like contacts. Each agent has one conversation: it shows one task at a time, a message continues that task in its session, and **Start a new task** begins another with a session of its own. It runs on macOS and Linux. Windows is untested: it has no local server, so there it could only use a remote one.

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

One sidebar holds **Needs you**, **New agent**, the agents, Usage and Settings, in every view except Getting started. Its line above Usage says **Protected** with the machine and the number of agents sealed, **Vault locked** or **Secure room stopped** when agents there cannot work (it then opens Needs you), or **Not connected**; with several machines it counts the connected ones. With more than one machine, New agent and Usage have a machine selector and the agents are grouped under machine headings; with one machine and no discovered peer, the selector and the headings are left out. An agent view follows the machine of the selected agent. Each row shows the agent's name (its `@id` when it has no other name) and its state or latest task title in one line, cut with an ellipsis and shown in full on hover; the line's rule is amber while an approval waits and red after an error. While a machine is not connected, its views show a checklist (background service, secure room, vault, agents) with **Try again** or **Connect** and a link to Machines. The app keeps its window state in its own profile: `~/Library/Application Support/Anchi Desktop` on macOS, `~/.config/Anchi Desktop` on Linux. macOS takes an app's name in the menu bar, the Dock and Activity Monitor from its bundle, so on macOS `build.mjs` keeps a copy of Electron.app as `dist/Anchi.app` (name, bundle id `dev.anchi.desktop`, executable and icon changed, signed ad hoc) and `scripts/anchi-desktop` starts that. The copy is made again only when Electron or the icon changes.

## Getting started

In **Settings → Machines**, **Add a machine** asks for a name and an SSH host that `ssh` on this computer reaches with a key; **Other ways: add an instabox box** switches the form to an instabox machine. Adding a remote server without Anchi offers a native **Initialize** dialog. It installs the matching published Linux x86_64 release and starts the daemon through SSH, then opens the guide. The packaged app includes the setup resources; no source checkout is required. A saved machine with a missing bridge shows **Initialize** so you can resume later. See [remote requirements and data locations](REMOTE_SERVER.md#set-up-a-server).

The window opens Getting started for each server it has not finished the guide for, unless that server already has an agent with a finished task (a stopped secure room or a locked vault is then listed in Needs you instead): switching to a new server opens it again, once per window. **Settings → About & updates → Open the guide** opens it again. The guide has what Anchi protects on the left and three steps on the right, each available once the one before it is done:

1. **Set up the secure room:** lists missing host tools with the command that installs them; otherwise **Set up** runs `setup.prepare`, which the guide starts by itself on a machine that has no VM yet (the system dialog still asks, and declining it leaves the button), for the suggested runtime (start or install the VM, its services and the runtime image, unlock the vault). A system dialog asks first and says to back up the vault key. The last line of its output shows while it runs; **Show details** shows more. If it stops, the step says why and offers **Try again**, which continues from what already finished. While it runs, the second step already offers **Sign in with ChatGPT**: the daemon keeps that login and imports it into the vault once the vault exists. **Use another machine** lists the machines, to prepare a remote server instead.
2. **Sign in to an AI account:** the account cards of Settings → AI accounts. For ChatGPT (Codex), **Sign in with ChatGPT** opens the sign-in page in your browser and shows a one-time code to enter there; the daemon on the selected machine, local or remote, keeps that login and refreshes it, with no Codex CLI to install. For Claude (Claude Code), **Sign in with Claude** opens Claude's sign-in page; on this computer it finishes by itself, and for a remote server you paste the code the page shows into the card. Anchi then stores a one-year subscription token; **Paste a token or API key** is the manual alternative. **Import Codex login** instead imports the login of the machine the daemon runs on; when it has none, the card names what to run there (`codex login`, or on a remote server `instabox ssh <machine>` or `ssh <host>` followed by `codex login --device-auth`).
3. **Meet your first agent:** creates `@dev` (no connectors, no workspaces) on the suggested runtime, then offers three starter tasks; choosing one opens the agent's conversation.

Skip for now leaves the guide until it is opened again.

## What it does

The agent list discovers agents on all connected machines without copying their profiles or granting new delegation permissions. Same-name agents remain separate. Offline machines keep their last known agent list for this desktop session, marked offline.

A working agent's avatar has a small, pale green dot orbiting it every 2.8 seconds, with no
ring or glow. Adjacent rows start at different positions to keep a busy team visually quiet.
The dot stops when work finishes or the machine disconnects; waiting approvals, queued work
and errors keep their own status dots and text. The system's reduced-motion preference keeps
the working dot stationary.

When the agent list shows host headings, click one to collapse or expand its agents; Enter or Space also toggles a
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
| Agents | Pick an agent from any connected machine. Its header shows the AI account it thinks with, its connections and whether it sees any of your folders. **Chat** shows one task as a conversation: what was asked, the folded tool calls, what the agent said, the tasks it handed off, and a held write as an approval card. The box under it replies to that task in its session once its turn has ended; while a turn runs it takes no reply. **Start a new task** switches the box to a new task with a new session, where nothing carries over; **Back to the current task** returns. A failed or cancelled task offers **Retry** (the same session) and **Start over** (a new task with the original request); a running one offers **Cancel**. |
| Access and Advanced | Two tabs beside Chat edit one draft of the agent's settings. **Access** has its connections, each with whether its writes ask first, go out without asking or follow the default; the folders it sees with read-only or read-and-change, the teammates it may hand work to, and the high-risk operations it may do without asking; **In plain words** beside them lists what the agent can and cannot reach, following the draft before it is saved. **Advanced** has its name and description, AI account, model, thinking effort, instructions (added to or replacing the template's), skills, its schedules (a preset or a cron expression and what to do each time) and checks for new GitHub or Linear issues, the websites it may reach (any public website, or only a list of hosts to add to and remove from) and deletion. With a daemon that cannot edit the host list yet, an agent that has one takes one more host at a time (**Allow this host…**, after a system dialog). Review changes shows the change to the agent file, with its errors and warnings; Apply writes it, and is refused if the file changed since the review. Settings only the agent file sets (template, image, sandbox, and with a daemon that cannot edit them yet, schedules and per-connection approvals) are shown read-only under Advanced. |
| History and task record | **History** lists the agent's tasks, newest first, with a search box (words in the title or the result, also searched on the machine for tasks older than the newest 500) and filters for running, waiting-for-you and failed tasks; tasks started by a schedule or another agent carry a clock mark. The selected task shows its time, replies and tokens, the tasks it handed off and its result, with **Open conversation**, Retry, Start over, Cancel task and **Delete…**. Deleting asks in a system dialog that names the task and how many tasks it delegated; a running task must be cancelled first. In a conversation, **What it touched** opens the task's record from the egress proxy's audit log: the accounts used, the websites reached, what was refused, the credential scan and the number of cells. |
| New agent | Templates (code reviewer, developer, inbox assistant, researcher, social drafter) fill in a request to the builder that you can edit before sending; the builder is one conversation and drafting uses a model call. **Blank agent** takes an id and an AI account and makes a starter with no model call; with saved nodes it can instead name an existing agent on another machine. A proposal opens in a panel the app draws from the proposed file: what the agent could reach in plain words, its errors and warnings, and the file's diff under **View the agent file**. Create agent (or Apply) writes it, Discard drops it. |
| Needs you | One inbox for every connected machine. Held writes come first, oldest first, each with the connector and host, the operation, the reason, the origin chain, the full summary and a countdown, then Deny and Approve; with several machines each card names its machine, and the decision goes to the machine that holds the write. Below them: a locked vault (**Unlock**), a stopped or outdated secure room (**Start**, **Update**), a machine that does not answer or has no Anchi yet, a machine that can be upgraded, and a newer release of the app (**What's new**, **Copy command**, **Remind me tomorrow**). The sidebar counts all of them. A write left waiting is refused when its time runs out. The same approval card appears in the task's conversation. |
| Usage | Select a machine to see its usage. Subscription windows per AI account, and token totals by agent, model, account or day over 24 hours, 7 or 30 days. |
| Settings | Six sections. **AI accounts**: ChatGPT (Codex), Claude (Claude Code) and Other provider (Hermes), each Connected or Not set up, with browser sign-in, importing the server machine's `codex login`, a pasted token or API key, or a base URL, model and API key. **Connections**: proxy connectors and service connectors in one list, by name with the service's mark (bundled Simple Icons paths; AWS, Firecrawl and Slack show their initial). A token is typed in a dialog over the window (Escape, its close button or a click outside closes it) that says where the token comes from; GitHub also offers **Use the gh login** and AWS **Use an AWS profile**, each after a system dialog that says what agents get. Gmail, Drive, X and Reddit sign in through the browser; without the OAuth app their sign-in needs they link the guide as **Needs an OAuth app ↗** and offer **Add app** (Google's client JSON is chosen in a system file dialog and read by the app, not the window; X and Reddit take the app's Client ID, Reddit also the developer username). Services have **Allow** or **Ask first** for their writes. A service's Disconnect asks first in a system dialog that says whether the provider revokes the credential too; Gmail and Drive list each account on its own row, and an account or service whose remote revocation is still pending offers Revoke again. A connector that is not connected links its setup guide (**How to connect ↗**), a section of [Connectors](CONNECTORS.md), through `https://anchi.elseward.xyz/docs/connect/<name>`. **Skills**: added from a GitHub address (pinned to its current commit) or, with the local server, from a folder chosen in a system file dialog; Check for update shows the newer commit and the files it changes before Update installs it; Remove asks in a system dialog that names the agents still listing the skill. **Machines**: `local` and the saved remote servers of `anchi server ls` (connect several together, configure one, add an SSH host or an instabox machine under a name, upgrade or forget one), and **Link machines into a team**. **Security & recovery**: the vault and where its key is; the secure room's size and versions with **Check & repair** (the same `setup.prepare`); the background service with **Start when I log in** for this computer, which installs or removes the login item of `anchi daemon install` after a system dialog (removing it stops a daemon that login started); **What agents reached**, the last seven days of `access.summary` per agent with the most requested hosts and the last refusals; and **Reset Anchi**, which needs the word `reset` typed and then a system dialog. **About & updates**: versions and the guide. With several machines, the sections that belong to a machine have a machine selector; switching machines closes open credential forms, and credentials are never copied between machines. |

Saved machines connect automatically when the app opens and retry independently after connection failures. A missing bridge waits for **Initialize** instead of retrying. **Disconnect** closes only that desktop connection for the rest of the session (until **Connect** or reopening the app); it does not stop the daemon or its tasks. Removing a saved machine asks first in a system dialog: the app only stops connecting to it, nothing on that machine is deleted, and when it belongs to a team the dialog says that the other members go on listing its agents until it is revoked from the team. It then closes its connection and removes its rows. The selected machine is remembered as the CLI server choice.

Usage shows the selected machine's records; Needs you shows every machine's. Coordinator approvals and usage already include delegated work, so execution-node records are not summed into them.

The app does not:

- run single setup steps (`setup.run`); Check & repair runs the whole preparation;
- stop the daemon;
- change the VM's CPUs or memory;
- import AWS access keys typed by hand (it connects AWS through a profile);

Use the CLI or the agent file for these.

To delete an agent, open its **Advanced → Delete agent…**, review the affected data, type its
exact id and choose **Continue to confirmation**. A native dialog names the agent and machine
before deleting its configuration, task history (including delegated tasks), triggers and VM
home, sessions, skills and policy. Active tasks are cancelled. Workspace directories and audit
logs are retained. The dialog remains open to report partial cleanup and offers another review
when cleanup must be retried. The built-in builder is protected.

A saved server needs an updated daemon to edit delegation. Older daemons show the allowlist read-only with an upgrade message. The teammate picker under Access lists agents on that machine, excludes the source agent and preserves missing recipients until you remove them. For a team member running elsewhere, edit its coordinator allowlist here and the execution profile’s allowlist on its own machine.

## Boundaries

- **Main process:** the Electron main process holds one connection per machine: the local socket and `anchi-bridge` over SSH for a remote server.
- **The window:** it is sandboxed, with context isolation, no Node integration, a content security policy that loads nothing from the network, no navigation and no new windows.
- **Calls from the window:** it reaches the main process through a narrow preload API. Every daemon call and notification carries a machine target registered in the main process; unknown or disconnected targets are refused without falling back to another daemon. Native file pickers and confirmation dialogs pin the original connection; disconnecting or reconnecting it while the dialog is open refuses submission. Confirmation dialogs name the machine. Daemon methods outside `DESKTOP_METHODS` (`packages/desktop/src/main/bridge.ts`) are refused there, which includes single setup steps and daemon shutdown. Destructive methods are allowed only through a native confirmation that the main process builds from what the daemon reports, not from what the window sent: agent deletion (typed id), task deletion (the dialog names the task and counts what it delegated) and reset (the word `reset`, refused while tasks run, checked again after the dialog).
- **Confirmations the window cannot give:** an agent settings change that gives the agent a new delegation recipient, a new connector, a new workspace or write access to one, that stops a connector's writes from asking, that adds a schedule or poll, or that lets it reach a new host or every public host again is confirmed in a system dialog from the main process, which compares the change with the agent's current settings. Cancel there, and the change never reaches the daemon. Removing a skill, preparing the environment (`setup.prepare`), a new high-risk exemption, importing the gh CLI's GitHub login, connecting AWS through a profile, adding a host an agent may reach, and letting X or Reddit post without asking are confirmed the same way; the X and Reddit dialog says that agents would then post publicly under the account, also from triggered tasks reading untrusted content. The window adds skills only from `https://github.com/` addresses; a folder on this computer comes from a system file dialog the main process opens, and only for the local server, since a remote server would read the path on its own disk.
- **Locked vault:** after the server or VM restarts, the sidebar says **Vault locked**, Needs you lists it with **Unlock**, and Settings shows **Unlock the vault** in place of the AI account and connection cards; the credentials are still stored. Unlocking goes through `setup.prepare`, whose system dialog asks **Unlock the vault?** when that is all it does.
- **Agent text:**
  - It is sanitized: control characters, terminal escapes and bidirectional overrides are removed.
  - Its Markdown is drawn as React elements, never as HTML: headings, paragraphs, lists (nested, and numbered from their first number), tables with column alignment (a wide one scrolls sideways; columns past 30 are dropped), quotes, horizontal rules, fenced code, bold, italics, strikethrough, inline code and web links. Quotes and lists stop nesting eight levels deep.
  - A link opens the system browser only for an `http` or `https` address, and its address is shown as its tooltip.
- **Trusted panels:** builder proposals and approvals are drawn by the app from the daemon's records, under a dark band that agent text cannot produce. The plain-words lists (Access, and a proposal's review) are computed by the app from the agent's settings as the daemon reports them; agent text does not enter them.
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

The agent list groups discovered agents by machine and prefers a direct connection when one is available. A machine only known through another one is shown as online or offline with the machine that reports it (`offline · through newuser`), without the error colour: it is that team's record, kept until the machine is revoked, also after the machine itself was deleted or reset.
You can submit tasks through a discovered member. Its Access and Advanced tabs explain which machine owns
its configuration; connect to that machine to edit it. Delegation choices display agent and
machine labels, including offline members. No delegation permission is added by joining alone.
