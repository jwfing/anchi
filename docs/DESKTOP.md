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

Release packages do not include the app yet.

## What it does

| Area | What you can do |
|---|---|
| Team | Pick an agent; its tasks read as a conversation. The box under it starts a new task in a new session; nothing carries over from the tasks above. Each card shows the status, the folded tool calls, what the agent is doing, and the result, with delegated tasks as chips. Continue this task, on a card whose turn has ended, opens the task and puts the cursor in its reply box. |
| Task panel | The selected task's time, turns and tokens, delegated work, full transcript, a reply that continues its session, and Cancel, Retry or Start over. Drag its left edge, or focus the edge and use the arrow keys, to resize it; a double-click restores the default. The conversation keeps at least 360 pixels. The width is remembered on this computer. |
| Agent builder | One conversation with the builder, or an empty starter (agent id and runtime) with no model call. A proposal opens in a panel the app draws from the proposed file, with its diff, errors and warnings; Apply writes it, Discard drops it. |
| Approvals | Held writes appear inside the task's card and in the Approvals view. Each shows the connector, operation, reason, origin chain, the full summary and a countdown, then Deny and Approve. A write left waiting is refused when its time runs out. |
| Usage | Subscription windows per runtime, and token totals by agent, model, runtime or day over 24 hours, 7 or 30 days. |
| Settings | Server (switch between `local`, `instabox:<machine>` and `ssh:<host>`), environment, runtimes, proxy connectors (token connect and disconnect), service connectors (sign-in, auto or ask writes) and the skill list. |

The app does not:

- delete agents or tasks;
- run setup steps or reset;
- stop the daemon;
- edit an agent's settings;
- add skills;
- import AWS credentials.

Use the TUI or CLI for these.

## Boundaries

- **Main process:** the Electron main process holds the daemon connection, as the CLI does: the local socket, or `anchi-bridge` over SSH for a remote server.
- **The window:** it is sandboxed, with context isolation, no Node integration, a content security policy that loads nothing from the network, no navigation and no new windows.
- **Calls from the window:** it reaches the main process through four calls. Daemon methods outside `DESKTOP_METHODS` (`packages/desktop/src/main/bridge.ts`) are refused there, which includes everything that deletes, resets or stops.
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
