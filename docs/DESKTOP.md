# Desktop app

The desktop app is a window onto the same daemon the TUI and CLI use. Agents are listed like contacts. Each agent has a conversation in which every message starts a new task with its own runtime session. A task's transcript and replies, which continue that task's session, open in a panel beside it. It runs on macOS and Linux. Windows is untested: it has no local server, so there it could only use a remote one.

## Open it

From a source checkout, after `pnpm --dir anchi install`:

```bash
scripts/anchi-desktop
```

The script bundles `anchi/packages/desktop` with esbuild and starts Electron. On first use, it also fetches the Electron binary for the platform. The window uses the same server as the CLI:

- `ANCHI_SERVER`, else the choice saved by `anchi server <target>`, else `local`.
- With `local`, it starts the local daemon through `scripts/anchi daemon start` when none is running. Set `ANCHI_CLI` to use another CLI.

The server in use shows as the server button at the bottom of the left rail, with a dot for its connection, and as a tag in each agent's header; the button opens Settings → Server. While the window is not connected, a banner across the top says why. Release packages do not include the app yet. The app keeps its window state, such as the task panel's width, in its own profile: `~/Library/Application Support/Anchi Desktop` on macOS, `~/.config/Anchi Desktop` on Linux. In a source run, macOS shows the Anchi icon in the Dock but still names the app Electron in the menu bar; packaging will fix the name.

## Getting started

A window that has not finished the guide opens on Getting started, unless the server already has a ready runtime, an agent and a finished task. The guide has four stages, and Settings → Getting started opens it again:

1. **Where Anchi runs:** this computer or a saved remote server (see Settings → Server).
2. **Prepare the environment:** lists missing host tools with the command that installs them; otherwise Prepare runs `setup.prepare` for the suggested runtime (start or install the VM, its services and the runtime image, unlock the vault) and shows its output. A system dialog asks first and says to back up the vault key.
3. **Connect a runtime:** the runtime cards of Settings.
4. **Meet your first agent:** creates `@dev` (no connectors, no workspaces) on the suggested runtime, then offers three starter tasks; choosing one opens the agent's conversation.

Skip for now leaves the guide until it is opened again.

## What it does

| Area | What you can do |
|---|---|
| Team | Pick an agent; its tasks read as a conversation. The box under it starts a new task in a new session; nothing carries over from the tasks above. Each card shows the status, the folded tool calls, what the agent is doing, and the result, with delegated tasks as chips. Continue this task, on a card whose turn has ended, opens the task and puts the cursor in its reply box. |
| Agent settings | The Settings tab beside an agent's conversation edits its name, description, runtime, model, reasoning effort, system prompt (added to or replacing the template's), skills, connectors and workspaces. Review changes shows the change to the agent file, with its errors and warnings; Apply writes it, and is refused if the file changed since the review. High-risk operations (merging a pull request, pushing to the default branch and the others in the agent's connectors) can be let through without approval for this agent. Settings only the agent file sets (template, image, sandbox, delegates, triggers, approvals, egress) are shown read-only. |
| Task panel | The selected task's time, turns and tokens, delegated work, full transcript, a reply that continues its session, and Cancel, Retry or Start over. Drag its left edge, or focus the edge and use the arrow keys, to resize it; a double-click restores the default. The conversation keeps at least 360 pixels. The width is remembered on this computer. |
| Agent builder | One conversation with the builder, or an empty starter (agent id and runtime) with no model call. A proposal opens in a panel the app draws from the proposed file, with its diff, errors and warnings; Apply writes it, Discard drops it. |
| Approvals | Held writes appear inside the task's card and in the Approvals view. Each shows the connector, operation, reason, origin chain, the full summary and a countdown, then Deny and Approve. A write left waiting is refused when its time runs out. |
| Usage | Subscription windows per runtime, and token totals by agent, model, runtime or day over 24 hours, 7 or 30 days. |
| Settings | Server (`local` and the saved remote servers of `anchi server ls`: use one, add an instabox machine or any SSH host under a name, which the app then tries once, or forget one), environment, runtimes, proxy connectors (token connect and disconnect), service connectors (sign-in, auto or ask writes, X and Reddit included) and skills. Each runtime shows Connected or Not set up with a Set up or Replace button: Codex imports the server machine's `codex login`, Claude Code takes a token or API key, Hermes takes a base URL, model and API key. A connector's token, like a runtime's credentials, is typed in a form that opens under its row; Escape closes it. Skills are added from a GitHub address (pinned to its current commit), or, with the local server, from a folder chosen in a system file dialog; Check for update shows the newer commit and the files it changes before Update installs it; Remove asks in a system dialog that names the agents still listing the skill. |

The app does not:

- delete agents or tasks;
- run single setup steps (`setup.run`) or reset;
- stop the daemon;
- import AWS credentials.

Use the TUI or CLI for these.

## Boundaries

- **Main process:** the Electron main process holds the daemon connection, as the CLI does: the local socket, or `anchi-bridge` over SSH for a remote server.
- **The window:** it is sandboxed, with context isolation, no Node integration, a content security policy that loads nothing from the network, no navigation and no new windows.
- **Calls from the window:** it reaches the main process through four calls. Daemon methods outside `DESKTOP_METHODS` (`packages/desktop/src/main/bridge.ts`) are refused there, which includes everything that deletes, resets or stops.
- **Confirmations the window cannot give:** an agent settings change that gives the agent a new connector, a new workspace or write access to one is confirmed in a system dialog from the main process, which compares the change with the agent's current settings. Cancel there, and the change never reaches the daemon. Removing a skill, preparing the environment (`setup.prepare`), a new high-risk exemption, and letting X or Reddit post without asking are confirmed the same way; the X and Reddit dialog says that agents would then post publicly under the account, also from triggered tasks reading untrusted content. The window adds skills only from `https://github.com/` addresses; a folder on this computer comes from a system file dialog the main process opens, and only for the local server, since a remote server would read the path on its own disk.
- **Agent text:**
  - It is sanitized: control characters, terminal escapes and bidirectional overrides are removed.
  - Its Markdown is drawn as React elements, never as HTML.
  - A link opens the system browser only for an `http` or `https` address, and its address is shown as its tooltip.
- **Trusted panels:** builder proposals and approvals are drawn by the app from the daemon's records, under a dark band that agent text cannot produce.
- **Secrets:** a connector token typed in Settings goes to the main process and then to the daemon. From there it travels as the CLI's does: into the vault on stdin.

## Checks

```bash
pnpm --dir anchi exec vitest run packages/desktop
node anchi/packages/desktop/scripts/drive.mjs steps.json [profile-dir]   # after a build; see the script's header
```

`scripts/drive.mjs` starts the built app with a debugging port. It then clicks, types, evaluates and takes screenshots from a JSON list of steps, and prints the page's errors. It runs the app in a profile of its own, a new temporary one unless you name a directory, so it does not share storage with an open Anchi window. On a Linux machine without a display, run it under `xvfb-run`.

## Limits

- **Live checks:** the app was tried against a local daemon on macOS, a remote instabox server from macOS, and a daemon on Debian 13 under Xvfb. Approvals were not tried live; they are covered by unit tests.
- **Windows:** has no local server, and is untested.
- **Session state:** new events arrive while the app runs. A reconnection reads agents, tasks and approvals again; transcripts load when their task opens. A builder proposal made while the app was closed does not appear in it: ask the builder to propose it again.
