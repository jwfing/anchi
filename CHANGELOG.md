# Changelog

Follows the Keep a Changelog structure. The version comes from `anchi/package.json`.

## Unreleased

### Added

- An **Approvals** view in the sidebar (**^X 5**) lists every write waiting for your decision, with the same details as the approval dialog: ↑ ↓ choose, y or n select, Enter confirms, a opens the full dialog, o opens the write's task. The sidebar item shows how many are waiting.

### Changed

- A write that starts waiting for approval raises a desktop notification also while the TUI is open (before, only when no TUI or CLI was connected); the notification names the connector, operation, reason and the minutes left to decide. `desktopNotifications: false` in `~/.anchi/settings.yaml` turns desktop notifications off (approvals, credential alerts, scan findings, subscription limits, finished tasks while no TUI is open).
- The Agent builder no longer writes `egress: []` on its own: the builder prompt now says to omit `egress` unless you ask to limit the agent's hosts (without it the agent reaches any public host), to write an empty list only when you ask for an agent without network access, and to omit `maxTasks` unless you want another limit. Before, builder-made agents often got `egress: []`, which allows nothing beyond the runtime and connectors, so their package installs and web fetches failed.
- `anchi agents create` and **Ctrl+X, N** write a starter without `egress: []` and `maxTasks: 1`: the starter reaches any public host and runs up to three tasks at a time, like an agent file that leaves both fields out.
- A task's view keeps showing the full transcript after a reply when you continued the task from that view (more than one message of yours); before, the view folded to the last result as soon as the turn ended. The result view ends with the key that shows the transcript (`^X h` by default).

### Fixed

- The skill-update confirmation shows file names from the skill repository with escape sequences and control characters removed, like every other text from outside. (#98)
- A task's view keeps the events that arrive while its history is still being fetched; before, a tool result or message in that window was missing for the rest of the session, and a finished tool call could stay shown as running. (#99)
- Usage and Access scroll by page with PgUp and PgDn, and `scroll:pageUp`/`scroll:pageDown` can be bound in those views; a task view's command palette lists the input's actions too; scrolling stops at the last line of a report or dialog, so the other direction answers at once instead of after as many presses as went past the end. (#100)
- A builder proposal the daemon refuses to apply stays available under ^X o; `anchi approvals` prints a held write's summary line by line; `--json` output drops C1 control characters and bidirectional overrides; `anchi update` explains a non-JSON answer from GitHub instead of failing with a parse error. (#101)
- `anchi retry --fresh` on a delegated task starts the new task as yours (its origin no longer claims a delegation with no parent) and notes the original task in it; the starter runtime picker is a full-screen dialog like the others; the sidebar's limit of the newest 500 tasks is documented. (#103)
- Approving a builder proposal that replaces or creates an agent file is refused when the file changed since the proposal was made (edited by hand, or created by another client between the review and the approval), with "ask the builder again" — as patch proposals already were. Before, the write silently overwrote the newer file with the YAML the stale diff was reviewed against. A `create` proposal also writes create-only now, so a file that appears at the moment of approval is never replaced. (#92)
- Starting a Google sign-in while an earlier one for the same service and account is still waiting no longer lets the earlier attempt report "sign-in cancelled or timed out" minutes later: the replaced attempt's timer is cleared and it ends silently, while the new attempt's success and timeout behave as before. (#93)
- A task whose agent moved to another runtime no longer hands its session's thread id to the new runtime. Replying to such a task (or `anchi retry` without `--fresh`) is refused with a message naming both runtimes — a session belongs to the runtime it started on — and the task keeps its recorded runtime instead of having it overwritten; `anchi retry --fresh` or a new task continues on the new runtime. Built-in agents keep running pinned tasks on the old runtime, as before. (#90)
- Opening a task with a very large transcript no longer closes the TUI with "daemon connection closed". `tasks.events` returns the transcript in bounded pages instead of one response, which past 8 MiB (about 500 full-size tool results) exceeded the client's frame limit on every try, so the task could not be opened at all; the TUI and `anchi` CLI page until the transcript is complete. (#85)
- The settings panel and builder patches accept an agent with every connector. The limit was still the 7 connectors of an earlier release, so saving 8 or more of the 12 that exist was refused with "Too big: expected array to have <=7 items"; it now follows the connector schema. (#87)
- An invalid cron expression (`0 25 * * *`, `*/0 * * * *`, names like `MON-FRI`) or a blank trigger `text` is now an error when the agent file loads, shown on the agent, instead of loading silently as a trigger that never fires. A trigger run that still fails records `error: …` where `anchi triggers` shows the last result and waits for the next scheduled minute, rather than retrying every 30 s and filling the daemon log. (#86)
- Cancelling a task that is still waiting for a free cell ends it at once. Before, the cancel was lost: the task stayed running, took a cell when one freed and ran the whole turn anyway, and deleting its agent waited a minute and removed the task while the turn could still start. The wait for a cell now observes the cancel, and a cancel that lands while the cell starts ends the task before the turn runs. (#84)
- A cell reused for a follow-up turn no longer counts as idle while that turn runs: before, under cell pressure (`maxCells` reached) the daemon could close it as the "longest-idle" cell to make room, killing the running turn (or a turn waiting on a delegation) and failing the task. A reused cell whose turn has finished still makes room as before.
- A guest command that exits before reading its stdin (VM stopped, guest refuses early, or killed on timeout) no longer crashes the daemon with an unhandled EPIPE; the failure surfaces as the command's result. An agent whose assigned skills exceed 8 MB as a bundle — the most the guest accepts on stdin — now fails the task with a clear message instead of hitting that crash on every start.
- Cancelling a task that already finished (done, failed or cancelled) is a no-op: before, a second `^X c` or `anchi cancel` on a cancelled task overwrote its partial reply and links with `cancelled`, moved its finish time and repeated the "↳ … cancelled" notice in the task that delegated it. Cancelling a queued task also recorded its end twice. (#89)

## 0.3.3 — 2026-10-12

Four boundary fixes in the VM, from a review of 0.3.2: the egress proxy decides on the host a connection goes to, GraphQL mutations are found wherever they sit in a document, and the cell manager writes the agent's home and mounts workspaces without following links. After updating, run `anchi setup install` once: it installs the proxy and cell manager that carry them; until then the VM keeps the 0.3.2 behavior and Getting started reports its components as outdated.

### Fixed

- The egress proxy decides rules, credential injection and egress lists on the host a request's connection goes to. A request whose `Host` header names another host is refused with HTTP 400 and audited as `host-mismatch`; before, the header chose the rule, so a cell could have a connector's credential injected into a connection to a host of its choosing. Needs `scripts/anchi setup install`.
- GitHub and Linear GraphQL requests count as writes, and are checked for high-risk mutations, when a `mutation` operation appears anywhere at the top level of the document (after a comment, a byte-order mark, a comma or another operation), not only as its first word; a GitHub GraphQL request whose document cannot be read is held as high-risk (`github-graphql-unreadable`, like an unreadable push), and an unreadable Linear one counts as a write. Before, a mutation behind a comment passed as a read, outside `approvals: ask` and the high-risk holds. Needs `scripts/anchi setup install`.
- The cell manager writes Codex's placeholder files into the agent's home without following links: a link, file or directory left where `.codex` or its files should be refuses the cell (`AGENT_HOME_LINK:<path>`, with a hint) instead of creating or handing over whatever the link named. Needs `scripts/anchi setup install`.
- Workspaces are mounted, and the read-only masks of `rw` workspaces attached, from descriptors resolved without following links, so a directory renamed or linked while a cell starts cannot move a mask or the mount. A writable folder with more than 1000 masked paths refuses the cell (`WORKSPACE_TOO_MANY_MASKS:<name>`). Needs `scripts/anchi setup install`.
- The hint after `cell start failed: <code>` also appears for codes that carry a detail (`WORKSPACE_NOT_A_DIRECTORY:<name>`).

## 0.3.2 — 2026-10-12

Agents without a Codex login: the builder runs on any connected runtime and a starter agent can be created without a model call. Anchi now notices VM components installed by another version, and the approval timeout is configurable. After updating, run `anchi setup install` once: it gives the VM the guest command and proxy settings this release uses; until then Getting started reports the VM's components as outdated and the proxy keeps the five-minute approval timeout.

### Added

- Create an agent without a Codex login or model call: `anchi agents create <id> --runtime codex|claude-code|hermes` previews a starter with no connectors, shared folders or extra egress hosts. `--preview` inspects without saving; `--yes` saves non-interactively. Getting started and **Ctrl+X, N** offer the same workflow. Creation refuses existing ids, including files that appear after review.
- `anchi agents --json`, `anchi tasks --json` and `anchi approvals --json` print arrays for scripts.
- A first-task walkthrough, user roadmap, actual TUI preview with example data, issue forms and a PR template.
- Anchi tells you when the VM's components were installed by another version: `setup.status` reports `appVersion`, `guestVersion` (`anchi-cell version`, from `/opt/secure-vm/installed.json`) and `guestOutdated`; Getting started goes back to its environment step and **Enter** (or `I` in Runtimes, which shows both versions) runs `anchi setup install`; the daemon logs it, tasks started meanwhile carry a notice, and `anchi update` says to run it. A guest from before this release counts as outdated until `scripts/anchi setup install` has run once.
- `builderRuntime` in `~/.anchi/settings.yaml` (`codex`, `claude-code` or `hermes`) picks the Agent builder's runtime; a task keeps the runtime its session started on (`runtime` in the task row).
- Runtimes and `anchi setup status` show the VM's CPUs and memory (`vmSize.current`), and `anchi setup status` prints a summary (`--json` for every field). A VM that runs but cannot be asked is reported with the failing command's message (`error`), in Getting started, Runtimes and the CLI, instead of as "not installed". A Lima older than the VM template needs (2.2.0) is listed with the missing prerequisites, and `anchi setup install` stops before creating the VM.
- `approvalTimeoutMinutes` in `~/.anchi/settings.yaml` (1–720, default 5): how long the egress proxy holds a write for your approval before refusing it; the dialog counts down from it. The proxy keeps it across restarts; Gmail, Drive, Notion and Slack approvals keep the policy service's ten minutes. Needs `scripts/anchi setup install` (an older proxy refuses the setting and keeps 5 minutes).
- `anchi cancel`, `anchi setup disconnect` and `anchi skills rm` say what they did; `anchi agents` shows each agent's runtime; `anchi setup status`, `cancel`, `skills rm` and the `daemon` subcommands have help descriptions. Text and secret dialogs in the TUI take **^U** (clear) and **^W** (delete the last word).

### Changed

- The landing page logo, favicon and hero animations use a simpler split-diamond silhouette, with a 7:3 upper-to-lower triangle ratio and a clear central gap.
- README leads with developer workflows, prerequisites and the first task; guides use the installed `anchi` command, explain source/release differences and document default VM sizing. Skills document release-matched installation and separate host CLI administration from in-cell MCP permissions.
- Release publication derives version-specific notes from CHANGELOG, preserving migration instructions, and refuses missing, duplicate or empty version entries. Apache-2.0 text is now in `LICENSE`, with copyright in `NOTICE`; packages include both.
- Landing pages link to releases and support, explain setup and preview limits, and use a supported Linear connector in both animation exports. The approval example requires a choice and confirmation, matching the TUI.
- The install confirmation says what a first installation downloads and that it can take up to half an hour; Getting started shows the elapsed time next to the phase, and a step that runs past 45 minutes is named in the error. Connectors keeps every id in one column, lists **a** (another Google account) and **o** (Google client) in its hints, and tells Gmail and Drive users without a Google OAuth client where to start; Runtimes says to run `codex` first when the imported login has expired; Team overview without agents names the keys to Getting started and the builder.
- The Agent builder runs on the first connected runtime (Codex, then Claude Code, then Hermes) instead of always Codex, so a user without a ChatGPT login can build agents. Getting started's runtime step accepts any connected runtime and lists Hermes (`h`) beside Codex and Claude Code.

### Fixed

- First-run setup checks that an existing agent has a connected runtime and opens a ready agent for the first task.
- Security descriptions now state that listed high-risk operations are held by default, explain global/per-agent exemptions and explicit `ask` precedence, and avoid implying that credential isolation keeps content local. SECURITY links directly to private vulnerability reporting.
- The builder's instructions no longer describe Codex and Claude Code as part of the base image; each runtime is a layer of its own since 0.3.0.

## 0.3.1 — 2026-10-11

Five more connectors through the egress proxy. After updating, run `anchi setup install` once so the VM's proxy, vault and cell manager know them.

### Added

- PostHog, Sentry, Firecrawl, Figma and Discord connectors through the egress proxy: `anchi setup connector <id>` (or **Connectors** in the TUI) stores the token, the proxy verifies it and injects it into the service's API only; agents use the placeholders `POSTHOG_PERSONAL_API_KEY`, `SENTRY_AUTH_TOKEN`, `FIRECRAWL_API_KEY`, `FIGMA_ACCESS_TOKEN` and `DISCORD_BOT_TOKEN`. PostHog US and EU Cloud and `sentry.io` only; Discord through REST, without the gateway. Key and token creation and Discord webhooks are denied, and new high-risk entries hold deletions, member and permission changes and Figma webhooks. Firecrawl fetches any URL, beyond an agent's `egress` list. Needs `scripts/anchi setup install`.

### Fixed

- The proxy no longer reports Linear's placeholder key as a credential the cell brought itself (a notification once per cell).
- `scripts/install-anchi.sh` (run by `anchi setup install`) records the Anchi version in the VM's `/opt/secure-vm/installed.json`; it wrote `unknown` since 0.3.0.

## 0.3.0 — 2026-10-11

Hermes Agent joins Codex and Claude Code as a runtime, the VM is renamed `anchi-vm` and a new VM is sized from this computer. After updating, run `anchi setup install` once: it renames an existing `secure-vm` VM in place, moves the vault key to `~/.config/anchi/vault.key` (update your backup notes) and installs the guest pieces several changes below need. The first task of each runtime then builds that runtime's image layer.

### Added

- A new VM gets half of this computer's CPUs and memory (at least 1 CPU and 2 GiB) instead of a fixed 4 CPUs and 4 GiB, and you can pick other numbers before it is created: the TUI asks for both with half filled in, `anchi setup install` asks too or takes `--cpus` and `--memory`, and `scripts/up.sh` reads `ANCHI_VM_CPUS` and `ANCHI_VM_MEMORY_GIB`. The size cannot exceed this computer. An existing VM keeps its size (`limactl edit anchi-vm --cpus N --memory N` changes it). `setup.status` reports `vmSize` and `setup.run` takes `vmSize` for `install`.
- **Tab** in the TUI's credential dialogs (connector tokens and keys, the Claude Code token, Hermes's API key) shows the input to check it and hides it again; the next field starts hidden.
- Hermes Agent as a third runtime (`runtime: hermes`), on an OpenAI-compatible endpoint you choose: `anchi setup hermes --base-url … --model …` (or **h** in Runtimes) stores the base URL, API key and default model in the vault. The cell runner drives Hermes over ACP with the Anchi MCP server; the proxy substitutes the key under the endpoint's base URL only, replace-only. Hermes 2026.9.24 is pinned by commit and hash in `guest/cell.env` and installed with its hash-locked dependencies on Debian's Python. Needs `scripts/anchi setup install`.
- `maxCells` in `~/.anchi/settings.yaml` (1–16, default 4): how many cells work at once across all agents. It applies at once, and a value outside the range becomes the nearest one allowed with a line in the daemon log. Give the VM more memory before raising it much (`limactl edit anchi-vm --memory 8`): a working cell may use up to 2 GB.
- `skills/anchi/`: a skill that teaches an agent to operate Anchi (setup, runtimes, accounts, agent files, tasks, delegation, triggers, approvals, audit, troubleshooting), with rules against handling secrets or approving writes for the user. Install it in Claude Code or Codex, or give it to Anchi agents with `anchi skills add https://github.com/jwfing/anchi/tree/main/skills/anchi`. Its CLI reference is generated by `scripts/gen-skill-cli.py`.
- `AGENTS.md`, `CLAUDE.md` and project skills in `.agents/skills/` (linked as `.claude/skills`) give Codex, Claude Code and other coding agents the development rules: checks, security boundaries, protocol and configuration changes, guest changes, adding a runtime and documentation.
- The base image has developer tools: build-essential, pkg-config, Python 3 with pip and venv, pnpm, Go, Rust (cargo, clippy, rustfmt), ripgrep and fd. Go, Rust and pnpm are pinned by version and hash in `guest/cell.env`. The base layer is named after its build script too, so a changed script rebuilds it (and the recipes on it) at the next task.
- Skill collections: `anchi skills add` with a directory or GitHub repository that has no top-level `SKILL.md` (such as `https://github.com/addyosmani/agent-skills`) adds each `<name>/SKILL.md` and `skills/<name>/SKILL.md` in it, each pinned and updated by its own tree URL. Skills that cannot be added are skipped and reported. `skills.add` returns `{added, skipped}`.
- High-risk exceptions per agent: `highRisk: { disable: [github-merge] }` in an agent file lets that agent do those operations without waiting for approval, while every other agent still asks; unknown ids are an error. `approvals: {<connector>: ask}` still holds every write of its connector, including those operations. A task's access report and the agent's settings panel show the exceptions. Cells of an agent with `highRisk` need the guest components of this release (`scripts/anchi setup install`); an older guest refuses the cell instead of starting it without the exception.
- `anchi update` installs the latest release; `anchi update --check` checks without installing. Updates preserve custom installation paths, running daemons and configuration, verify the checksum and version before switching, and skip reinstalling or downgrading.
- Packaged self-update uses its bundled installer, so it does not need a checkout or download and execute a new installer script.
- Selection mode (**^X m**): mouse reporting off and the transcript full width without borders, so the terminal selects and copies text natively; any key but the arrows and PgUp/PgDn ends it.
- Agent replies and task results render Markdown: headings, emphasis, inline and fenced code, lists, task lists, quotes, rules and tables.
- A running turn shows a working line under its transcript (elapsed time, the running tool or the latest reasoning summary or plan). Codex reasoning summaries and plan updates and Claude thinking are recorded as `progress` events, shown in the verbose transcript.
- Tab completes paths in path inputs (Google OAuth client JSON, skill directories).
- The agent builder sees which runtimes are connected, and proposals warn about an unconnected runtime.
- The agent settings panel shows and edits name, description, runtime, model, effort and prompt (prompt text in `$EDITOR`). It also shows the settings it cannot edit, and which values an agent inherits from its template. Changes go through the same diff review.
- The agent builder can change existing agents. It gets a summary of every agent and the files of the agents your message names. It proposes `anchi-agent-patch` blocks that change only the fields given and keep the rest of the file, comments included. The patch is refused if the file changed since it was proposed.
- Several Google accounts per Gmail and Drive: `anchi setup service gmail --account work`, and `accounts: { gmail: work }` in an agent file picks one (`default` otherwise). The egress bridge pins the account to the agent's cells; approvals bind to that account. Accounts connected before are `default`; `anchi setup disconnect gmail --account work` disconnects one.
- A built-in Google OAuth client, used when a release ships one (none yet: Anchi has not passed Google's verification for the restricted `gmail.readonly` scope). An imported client takes precedence; `anchi setup google-client --remove` falls back to the built-in one. `setup.status` reports `googleClientSource`.
- `anchi setup reset` deletes the VM and its vault contents for a first launch, after showing what goes and a typed confirmation; `--all` also deletes the vault key and `~/.anchi` (keeping `keybindings.json`). Refused while tasks run.
- Gmail's account label is read from its profile, like Drive's and Slack's.

### Changed

- Codex and Claude Code are no longer in the base image: each runtime is an image layer of its own, installed the first time an agent of that runtime starts a task, so `setup install` is faster and unused runtimes are never downloaded. Layers are named by the hash of their build script and the pins it reads; the first task after updating builds the base and its runtime again.
- The Lima VM is named `anchi-vm` (was `secure-vm`), and the vault key lives in `~/.config/anchi/vault.key` (was `~/.config/secure-vm/vault.key`). An existing VM is renamed in place with `limactl rename` when the daemon starts, or by `scripts/anchi setup install`: a running VM is stopped, renamed, started and its vault unlocked again; its disk, vault and cells' data are kept. The key file is moved, not copied; update your backup notes. Nothing moves while task cells run in the VM to rename, an existing `anchi-vm` or key is never replaced, and a migration that fails leaves the VM under its old name instead of letting a second, empty `anchi-vm` be created. `ANCHI_INSTALL_VM` and `ANCHI_VM` take `anchi-vm` or `anchi-vm-<suffix>`. Paths and service names inside the VM (`/opt/secure-vm`, `secure-auth`, …) are unchanged.
- The Skills screen takes one line per skill (its id and `owner/repo @ commit`, or `local`), so a collection of 25 skills stays readable: the skills of one repository are listed together with local ones last, the list scrolls with the cursor and shows the position (`12/25`), and only the selected skill's description is shown, below the list. **PgUp** and **PgDn** move a page, **Home** and **End** (`g`, `G`) to the first and last skill.
- The status line always shows the command palette and key list hints at its right, whatever the width.
- Connectors shows Gmail and Drive as waiting for sign-in once the Google client is stored, instead of "not connected".
- The VM resolves provider hosts only for configured roles: auth once a Google client is available and a sign-in, token or pending revocation exists; a connector once it has a credential. A fresh VM makes no provider lookups, and sign-in, token import and disconnect update the allowlists at once instead of within two minutes.

### Fixed

- Codex agents can no longer use ChatGPT Apps or plugins. Codex offered the apps linked to the user's ChatGPT account (a cell posted to Slack through `mcp__codex_apps__slack`), and those calls acted as the user outside the agent's connectors, approvals and audit. The egress proxy now refuses `/backend-api/ps/`, `/backend-api/plugins/`, `/backend-api/aip/` and `/backend-api/connectors/` on `chatgpt.com`, and the runner turns off Codex's `apps` and `plugins` features. Use the agent's own connectors (`slack.post` and the others) instead. Needs `scripts/anchi setup install`.
- A Codex task whose session is gone from the VM (after `anchi setup reset` deleted the agent's files) no longer fails every message with `no rollout found for thread id`: the cell runner starts a new session for the task and warns that the earlier conversation is not in it. Other failures, and failures after the turn began, still fail the turn. Needs `scripts/anchi setup install`.
- The TUI reads keys a terminal sends in xterm modifyOtherKeys form (`ESC [27;mod;code~`). Before, Ctrl+C did not quit and the Ctrl+X leader typed its next key as text, so `^X n`, `^X m` and the other leader bindings did nothing.
- Workspaces on Linux hosts are no longer served one file operation at a time: `bindfs` runs multithreaded. Listing a `node_modules` tree in a workspace took 88 s instead of 3.4 s, and one agent installing dependencies stalled every other cell's workspace. `anchi setup install` mounts the share again. Agents are also told to keep dependencies and build output out of workspaces, which are slower than their own work directory for many small files.
- An agent file's `model` accepts provider model ids such as `nousresearch/hermes-4-405b` or `qwen/qwen3:free` (a letter or digit first, then letters, digits and `. _ - : / @ +`), so a Hermes agent can pick another model of its OpenAI-compatible endpoint, as the guide says. The settings panel accepts the same ids.
- Agents with workspaces are told where they are (`/home/agent/workspaces/<name>`, the user's `~/AnchiWorkspaces/<path>`, read-write or read-only) and that `/home/agent/work` stays in the VM. Before, Anchi's instructions named only `/home/agent/work`, so an agent could keep cloning and editing there, where the user never sees its files.
- Tasks waiting for a task they delegated no longer starve it of a cell. The VM's four cells could all be held by leads waiting for their reviewers, which then waited for a cell until they failed with `TOO_MANY_CELLS`. A cell whose turn waits on a delegation no longer counts toward the working cells, and waiting delegated tasks get a free cell first (deepest first, then in order, and only while the tasks before them would take every free cell). Needs `anchi setup install`: the VM now allows up to 16 live cells.
- One failed provider lookup no longer stops the refresh of the others; that host keeps its previous addresses until they expire.
- VM installation waits up to 10 minutes for the dpkg lock instead of failing when a fresh VM's `unattended-upgrades` holds it.

## 0.2.1 — 2026-10-09

### Added

- Resumable TUI getting-started guide with host prerequisite checks, vault initialization, setup progress and retained logs; persistent errors with recovery actions.
- Team overview showing active tools, queued tasks, held approvals and delegated work; completed task details prioritize results and artifact links with a history toggle.
- Per-conversation drafts and scroll positions, a growing multiline composer with paste review, and grapheme-aware Chinese/emoji editing.

### Changed

- Esc returns to navigation without clearing drafts or cancelling work. Cancelling requires confirmation. Held write approvals no longer steal focus and require a selected decision followed by Enter.
- Failed sends retain the draft; the composer explicitly labels new tasks versus follow-ups. Narrow terminals show one pane at a time.

## 0.2.0 — 2026-10-09

The agent team replaces the desktop app and Pi. Run `scripts/anchi setup install` to update an existing VM; it disables the Pi inference gateway and removes Pi from the cell root filesystem. Credentials in the vault are kept.

### Added

- Add standalone macOS Apple Silicon and Linux x86_64 packages, including Node, TUI,
  daemon and prebuilt cell runners; no source checkout or pnpm needed by users.
- Add the website's checksum-verifying `install.sh`, a global `anchi` command,
  `anchi --version`, and a two-platform GitHub release workflow.
- Updates retain existing daemon processes. After tasks finish, run `anchi daemon stop`
  and reopen the TUI; rerun `anchi daemon install` if login startup is enabled.

- Daemon, TUI and CLI (`scripts/anchi`) for a team of Codex and Claude Code agents, each task in a disposable nspawn cell on layered images, with an agent builder.
- Egress proxy that keeps credentials out of cells: replace-only runtime tokens, GitHub, AWS (re-signing, SSO profiles) and Linear injection, credential-minting denials, destination filtering against SSRF and DNS rebinding, connector verification at import.
- Gmail, Drive, Notion and Slack for agents through a per-cell bridge that names the agent to the service, so `approvals` holds one agent's writes; Google sign-in, tokens and write modes set up from the daemon.
- Delegation between agents, approvals of held writes, schedule and polling triggers, skills, task search, trees, deletion and retention.
- S3 `aws-chunked` uploads, signed or unsigned, re-signed by the proxy, also when streamed. S3 multi-object deletes, expiry rules, bucket policies and ACLs always ask.
- Linux hosts (experimental): notifications through `notify-send`, Google sign-in through `xdg-open`, `daemon install` as a systemd user unit, `/dev/kvm` and QEMU checks before installing.
- Deleting agents (D, ^X D, `anchi agents rm`): the agent file, its tasks with what they delegated (cancelled first), trigger state, its place in other agents' `delegates`, and its home, skills and policy rules in the VM, after typing its id. Workspaces on the Mac are never touched.
- Agent settings panel (^X s): skills, connectors and workspaces of an agent, saved after a diff, keeping the rest of the file. The builder gets an inventory of what exists each turn; proposals and settings changes are checked against it, and a proposal's settings can be picked in its dialog (s). `anchi skills update` and **u** on the Skills screen update a GitHub skill to the commit you reviewed; skills can be given an id when added.
- TUI key bindings: every action through the leader key Ctrl+X with a panel of the keys that follow, plain keys in views without text input, a command palette (^X Space), shell line editing in the chat input, and `~/.anchi/keybindings.json` (`anchi keys`). Ctrl+X alone, Ctrl+A, Ctrl+E, Ctrl+T and Ctrl+O no longer act as before: new task is ^X n, approvals ^X a, the editor Ctrl+G or ^X e, tool calls ^X t, the builder proposal ^X o.
- Running a failed or cancelled task again (R, ^X r, `anchi retry`): continue its session with a note of why it stopped, or start over as a new task.
- A task's external access (a, ^X l, `anchi audit`): hosts reached and decisions, credentials injected by the proxy, what the cell sent as credential, refusals, held writes, bridge calls and the scan, read from the egress proxy's audit log.
- A host refused by an agent's egress list is noted in the task, and can be allowed from the task's access view (e) or with `anchi agents allow-host`, after a confirmation.
- git pushes larger than 8 MiB work: a push without a length streams through the proxy, which reads its ref updates before any of the body leaves. High-risk pushes of this size are refused with git's own report instead of waiting for approval.
- Configure → Access and `anchi access`: every agent's external access over a period, the hosts most requested, credentials cells sent of their own and the latest refusals. Desktop notifications when a subscription window passes 80% and 95%, and when a limit is reached.
- A task's audit rows are saved by the daemon when its cells close, so its access record outlives the log's rotation; a cell sending a credential that is not a placeholder is noted in the task and notified at once.
- Token usage per turn (input, cached, output, reasoning, model, Claude Code's cost estimate) with totals by agent, model, runtime or day (Configure → Usage, `anchi usage`), and the subscription limits the egress proxy last saw: Codex's plan and 5-hour and weekly windows, Claude Code's rate-limit headers.
- Live checks `make verify-anchi` and acceptance script `scripts/anchi-acceptance.sh`.

### Fixed

- A task could fail with `TOO_MANY_CELLS` while a cell was still closing: the daemon counted only live cells, the VM every cell directory. The daemon now counts closing cells too, and a task waits up to 10 minutes for a free cell instead of failing.
- Codex agents with an egress list were refused OpenAI's content CDN (`*.oaiusercontent.com`), which Codex fetches its listed files from; it is now one of Codex's base hosts.
- Deleting an agent with an idle cell left its home in the VM (`AGENT_HAS_CELLS`): the purge ran while the cell was still releasing its overlay. Closing a cell now waits for it to exit, also when it was already closing.
- A request to a host outside an agent's egress list was audited as `pass` before its connection was refused, so the access view counted the host as reached. The proxy now refuses it as the request arrives, with a 403 that names the egress list.
- A push's ref updates were matched in the first 64 KiB of its body only, so a push listing many refs could hide an update of `main` from the high-risk check. Every update is now parsed, and a push whose updates cannot be read is high-risk.
- Installing (`setup install`, `scripts/install-anchi.sh`) and `make verify-anchi` ended running tasks: installing restarts the egress proxy, and the live checks reaped every cell. Both now refuse while tasks run, and the checks only ever reap their own cells.
- The egress proxy hit its 1024 open-file limit under package installs with hundreds of connections (`Too many open files`); the limit is now 65536.
- Request bodies over 8 MiB were audited as injected although their headers had already left; they are now audited as `pass:streamed`.

### Removed

- The Electron desktop app (`desktop/`), Pi (`pi/`), the Pi inference gateway (`secure-inference`) and the host directory broker. Use the TUI or CLI.

## 0.1.x — desktop app (retired in 0.2.0)

### Added

- English desktop interface by default, with a persistent English/Simplified Chinese toggle beside the sidebar collapse control. Pages, token entry, native confirmations and activity labels follow the selected language while chat and approval content remain unchanged.

- Persistent directory grants: schema v2 records device and inode at authorization, restores only unchanged identities and explains inactive moved/replaced/inaccessible directories.
- Recoverable file deletion/overwrite through hidden `.anchi-trash` inside each grant; inaccessible to agents.
- Gmail reauthentication-required state after invalid refresh credentials, avoiding repeated Google requests.
- Metadata-only `activity.jsonl` and desktop access to VM audit through `policy_admin.py audit`.
- Automatic pending-approval loading, navigation count badge, structured action/account/model/tool/recent-input summaries and expandable full JSON.
- Setup authentication-expiry and VM-version display; guest `/opt/secure-vm/installed.json`.
- `guest/cell.env` as the single source for cell UID mapping and Node/Pi pins, shared by shell, Python, Pi and tests.
- Cross-language transport-limit consistency tests for Python, Pi and desktop.
- `make lint` with Ruff, shellcheck and Prettier, including Pi; shellcheck CI, unsigned packaging smoke jobs and Dependabot.
- Regression coverage for service UID/rate limits, bridge approval waits and UTF-8 framing, egress refresh, readiness, nested multipart mail, directory restore, activity logs and configuration migration.
- Experimental Linux x86_64 desktop: Lima/QEMU/KVM, one dual-architecture VM template with explicit driver selection, pinned SHA-256 Lima/Codex downloads, user-run QEMU/KVM privileged steps, platform/downloader/tool-manifest/guest-architecture modules, Linux tarball and fresh-VM KVM CI.
- Drive, Notion and Slack connectors alongside registry-based Gmail: separate identities/egress, revision-bound writes, per-connector execution ledgers and quotas, separate static-token input window, dynamic Pi tool registration, descriptor-based cards and write-approval banners. The initial per-write approval design was superseded by authorization modes below.

### Fixed

- Restore write ledgers only for write-capable connectors, avoiding Gmail startup failure on its read-only filesystem. Failed recovery retains reads but rejects writes.
- Reject writable grants over Anchi code, runtime resources, real tool directories and installation roots. Standalone `~/bin` tools no longer protect the entire home; stale tool paths no longer terminate startup.
- Connector approval waits retain request IDs and support real-timer cancellation. Frozen writes do not refetch target revisions on replay. Preparation avoids holding SQLite write locks, reserves quota early and removes frozen content older than seven days.
- Drive text updates require a revision precheck with optional ETag; Google Docs overwrite is refused. Ambiguous remote writes become UNKNOWN; read-only POST remains a read.
- Local overwrite backs up before atomic replacement, uses fixed-length trash IDs, avoids orphan sidecars on copy failure and continues after short reads.
- Notion nested-block reading distinguishes truncated text from omitted nontext content; Slack history respects total serialized UTF-8 size.
- Download-failure cleanup waits for file open/close to avoid temporary-file races on macOS CI.
- Accept Codex reasoning items containing `content: []`, which Pi replays into later turns. Previously schema rejection before authorization broke subsequent model calls after the first reasoning summary.

### Changed

- Per-subject authorization modes for Gmail, Drive, Notion, Slack and `inference`: `auto` is default standing authorization for reads, writes and model calls; `ask` requires per-request approval. Both issue/audit one-time grants. Added `policy.sh rules` and `mode <subject> auto|ask`, retaining `read`/`gmail-read` aliases. Desktop mode restoration confirms prompt-injection risk; setup controls model mode. Changes revoke all unconsumed grants.
- Expired model authentication can be reimported or renewed without disconnecting Pi; rebuilding the environment still requires disconnecting.
- Cell/service JSON uses UTF-8 byte accounting, approximately doubling Chinese-context capacity compared with the previous escaped encoding.
- File broker uses setup-installed host Python rather than a fixed system interpreter.
- Renderer coalesces event-driven snapshots and preserves input focus; navigation is no longer blocked by long-running actions.
- Qisuo-to-Anchi migration: one-time user-data rename, canonical `ANCHI_*` release variables with legacy aliases, `local.anchi.desktop` development Bundle ID and `anchi-desktop`/`anchi-pi` package names.
- Main process injects the app version instead of hard-coding it in HTML.
- Documentation consolidated into one English README and current English usage, architecture, security and release guides. Removed historical proposals, implementation plans, legacy runbooks and dated acceptance reports; their original versions remain in Git history.

### Known incomplete work

Task-scoped grants, multiple agents, Gmail sending, context compaction, the future of legacy API-key inference, completed signing/notarization acceptance and automatic updates. See the README capability table.
