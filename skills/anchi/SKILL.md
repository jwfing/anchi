---
name: anchi
description: Operate Anchi, a secured agent team on your own computer — set up its VM and vault, connect runtimes (Codex, Claude Code, Hermes) and accounts, define agents in YAML, run tasks, delegation, triggers, skills, workspaces, egress limits, approvals, audit and usage, from the `anchi` CLI or TUI. Use when the user mentions Anchi or 安栖, wants to create or change an Anchi agent, give one a task, see what an agent accessed, handle a held write, or fix an Anchi setup.
---

# Using Anchi

Anchi runs a team of agents (Codex, Claude Code or Hermes) on the user's computer. Each task runs in a disposable cell inside a local Linux VM (`anchi-vm`, through Lima). Agents never hold credentials: an egress proxy in the VM injects GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord and model credentials on the way out, and trusted services in the VM act for agents on Gmail, Drive, Notion and Slack. Each agent reaches only the connectors, hosts, directories, skills and delegates in its YAML file.

Two front ends talk to one background daemon: the full-screen TUI (`anchi`) for people, and the CLI (`anchi <command>`) for scripts and agents. From a source checkout the CLI is `scripts/anchi`.

## Rules for an agent operating Anchi

1. **Never handle the user's secrets.** Tokens, API keys and Google sign-in are entered by the user: `anchi setup …` reads them without echo in a terminal, the TUI uses masked dialogs. Do not ask the user to paste a secret into the chat, and never pass one on a command line, in a file or **through a pipe**: every `anchi setup` command that takes a secret reads stdin when it is not a terminal, so `echo $KEY | anchi setup claude` or `gh auth token | anchi setup connector github` would work, and must not be done. Never `cat` anything under `~/.config/anchi/`. `anchi setup codex` and `anchi setup connector github --from-gh` copy a login from this computer into the vault (the gh token keeps all its scopes): run them only after the user agreed, and without `-y`.
2. **Never approve or deny a held write for the user.** `anchi approve <id>` exists for the user. Show them `anchi approvals` and let them decide, unless they explicitly told you to approve that specific write.
3. **Never loosen an agent's boundaries on your own.** Agent files, templates and `~/.anchi/settings.yaml` take effect as soon as they are saved, without a dialog. Change these only when the user asked for that change, and show them the diff before you save it: `approvals`, `highRisk` (in `settings.yaml` it exempts **every** agent), `egress`, `connectors`, `delegates`, `accounts`, `workspaces` and `sandbox`. The same goes for `anchi setup service-mode <service> auto` and `anchi agents allow-host`. Removing `approvals: ask` or adding a `highRisk` exemption is approving future writes for the user; making a task work is not a reason to do it.
4. **Commands that take effect at once need the user's go-ahead in the conversation**; most do not ask for confirmation, so the CLI is no safety net:
   - `anchi rm <task>`, `anchi cancel <task>`, `anchi skills rm <id>` and `anchi setup disconnect <id>` act immediately.
   - `anchi agents rm`, `anchi setup reset` and `anchi setup workspaces` (restarts the VM, ending running tasks) ask in a terminal; do not add `-y` unless the user asked for it.
   - Other edits to agent files (prompt, model, skills, triggers) are fine when they are what the user asked for; keep their comments. Edit files rather than the TUI when you work non-interactively.
5. **Report what Anchi says.** Errors carry a hint (`cell start failed: HERMES_NOT_CONFIGURED — set its OpenAI-compatible endpoint …`); pass it on instead of guessing.

## Where this skill runs

Host-side agents use the `anchi` CLI below. Inside an Anchi task cell, this skill is reference
material only: the host CLI, vault administration and full team control are not available.
Use the exposed `anchi_*` MCP tools within the current agent's delegate and task permissions.
Never install a host CLI or request host files to bypass those limits. Check `anchi --version`
and `anchi <command> --help` on the host; prefer the skill from the matching release.

## First run

```bash
curl -fsSL https://anchi.elseward.xyz/install.sh | sh    # macOS (Apple Silicon) or Linux x86_64
anchi                                                      # opens Getting started in the TUI
```

Prerequisites: macOS needs `brew install lima python`; Linux needs Lima 2.2+, Python 3.11+, QEMU and access to `/dev/kvm`. Getting started prepares the environment and selected runtime after one confirmation, then connects an account and reviews a starter named `dev`. The CLI equivalent for preparation is:

```bash
anchi setup prepare --runtime codex    # or claude-code / hermes; review and confirm
```

This creates or starts the VM, initializes or unlocks the vault and prepares the selected image;
it imports no account and calls no model. Existing keys are kept. The user must back up
`~/.config/anchi/vault.key`. Release packages download verified layers; source checkouts build
locally. Individual steps remain available (also in the TUI's **Runtimes** screen):

```bash
anchi setup install          # create the VM, install the trusted services, build the base image (minutes)
anchi setup vault init       # first time: creates ~/.config/anchi/vault.key — the user must back it up
anchi setup vault unlock     # after every VM start
anchi setup status           # VM, vault, runtimes, connectors at a glance
```

Then connect at least one runtime:

| Runtime | Command | What the user provides |
|---|---|---|
| Codex | `anchi setup codex` | A ChatGPT login: run `codex login` on this computer first; the daemon re-imports it as it refreshes |
| Claude Code | `anchi setup claude` | `claude setup-token` output, or an Anthropic API key |
| Hermes | `anchi setup hermes --base-url https://openrouter.ai/api/v1 --model <model>` | An API key for any OpenAI-compatible HTTPS endpoint |

Guided preparation installs the selected runtime before the first task; other runtimes are
installed on first use. One connected runtime is enough: the Agent builder runs on the first
connected of Codex, Claude Code and Hermes, or on `builderRuntime` from `~/.anchi/settings.yaml`.

## Agents

An agent is `~/.anchi/agents/<id>.yaml` (id: lowercase letters, digits, `-`). Minimal:

```yaml
name: Developer
runtime: codex                       # codex | claude-code | hermes
connectors: [github]
prompt:
  text: Fix the GitHub issue you are given, push a branch and open a pull request.
```

Every field, with examples, is in [references/agent-config.md](references/agent-config.md). The ones that bound what an agent can do: `connectors`, `egress`, `workspaces`, `approvals`, `delegates`, `accounts`, `highRisk`. Unknown fields are errors, which `anchi agents` shows for each file. Skills and delegates an agent names must exist: the builder and the settings panel refuse ones that do not, but an edited file only fails when a task starts (`skill "<id>" is not installed`), so check `anchi skills` and `anchi agents` first.

For a minimal starter, use `anchi agents create dev --runtime claude-code --preview`
(or `codex` / `hermes`). Review the YAML, then run without `--preview` to confirm in a terminal;
use `--yes` non-interactively only when the user authorized creating that reviewed starter.
No model is called and no connector or workspace is granted; egress stays open (no list). Existing ids
are refused. **Ctrl+X, N** opens this workflow in the TUI. On an older binary, use a manual file
with `connectors: []` and `workspaces: []`, and no `egress` line: an empty list would cut the
agent off from every host but its runtime's and connectors'.

People can also create agents with the **Agent builder** in the TUI (**^X b**): using a connected runtime, they describe the agent, the builder proposes a file, and a full-screen dialog shows it before anything is written. **^X s** opens an agent's settings panel (runtime, model, prompt, skills, connectors, workspaces), which also shows a diff before saving.

## Tasks

```bash
anchi run dev "Fix issue #42 in acme/api"     # start a task and stream it until the turn ends
anchi tasks                                   # newest first; -a <agent> -s running -q <words> --since 24h
anchi send <task> "Also add a test"           # a follow-up turn in the same session
anchi retry <task>                            # continue a failed or cancelled task; --fresh starts over
anchi cancel <task>
anchi rm <task>                               # delete a finished task and the tasks it delegated
```

`-v` on `run`, `send` and `retry` shows tool output. A task id looks like `t-…`. An agent runs up to `maxTasks` of its tasks at once (default 3), each in its own cell and session. Across all agents, `maxCells` cells work at once (default 4, in `~/.anchi/settings.yaml`); a cell waiting for a task it delegated does not count, and delegated tasks get a free cell first. Other tasks wait in line, and fail with `TOO_MANY_CELLS` after 10 minutes.

## Accounts (connectors)

| Connector | Connect | Agents reach it |
|---|---|---|
| GitHub | `anchi setup connector github` (fine-grained PAT) or `--from-gh` | `gh`, git over HTTPS, the API; the proxy injects the token |
| AWS | `anchi setup connector aws` (keys) or `--profile <sso-profile>` | AWS CLI and SDKs; the proxy re-signs requests; credential minting is denied |
| Linear | `anchi setup connector linear` | The GraphQL API; the proxy injects the key |
| PostHog, Sentry, Firecrawl, Figma, Discord | `anchi setup connector <id>` (token) | Their REST APIs with the placeholder in `POSTHOG_PERSONAL_API_KEY`, `SENTRY_AUTH_TOKEN`, `FIRECRAWL_API_KEY`, `FIGMA_ACCESS_TOKEN`, `DISCORD_BOT_TOKEN`; the proxy injects the real one. Discord: REST only, no gateway. Firecrawl fetches any URL, beyond an `egress` list |
| Gmail, Drive | `anchi setup service gmail [--account work]` (Google sign-in in the browser) | Tools in the cell (`gmail_*`, `drive_*`); Gmail is read-only |
| Notion, Slack | `anchi setup service notion` / `slack` (token) | Tools in the cell (`notion_*`, `slack_*`) |

An agent gets a connector only if its file lists it. Several Google accounts: connect each with `--account <name>` and pick one per agent with `accounts: { gmail: work }`. `anchi setup service-mode notion ask` makes every Notion write of every agent wait for approval. `anchi setup disconnect <id>` removes a credential.

## Approvals

Writes wait for the user when the agent's file says `approvals: { github: ask }` (per connector), and by default for listed high-risk operations (merging a PR, deleting or reconfiguring a repository, pushing to `main`, AWS deletions, Linear deletions, Discord moderation…) unless `highRisk: { disable: [...] }` exempts them.

```bash
anchi approvals          # what is waiting, with the task's origin chain
anchi approve <id>       # the user's decision — see rule 2
anchi deny <id>
```

In the TUI, a held write is announced without stealing focus. **^X a** opens review; choose **y** or **n**, then press **Enter** to confirm. An explicit connector `ask` still holds writes even when `highRisk.disable` exempts their pattern. Unanswered writes are refused after five minutes, or `approvalTimeoutMinutes` from `~/.anchi/settings.yaml` (connector services: always ten). Raising it is the user's call, like the other settings (rule 3).

## Teams, triggers, skills, workspaces

- **Delegation:** `delegates: [reviewer]` lets an agent hand subtasks to `reviewer` through its Anchi tools (`anchi_delegate_task`, `anchi_task_status`, `anchi_send_to_task`, `anchi_list_tasks`, `anchi_list_agents`, `anchi_whoami`). The TUI's Team overview (**^X 4**) shows the tree.
- **Triggers:** `triggers: [{schedule: '0 9 * * 1-5', text: …}]` or a poll of Linear issues / a GitHub issue search that starts one task per new item. `anchi triggers` lists them with their next run.
- **Skills:** `anchi skills add <dir | GitHub URL>` (a repository of skills adds each one, pinned to its commit), then `skills: [id]` in the agent file. `anchi skills update` shows what changed upstream before installing it.
- **Workspaces:** directories under `~/AnchiWorkspaces` (shared once with `anchi setup workspaces`), given to an agent with `workspaces: [{path: projects/api, mode: rw}]`; they appear at `/home/agent/workspaces/<name>` in its cells.
- **Images:** the base image has git, gh, build tools, Python, Node/pnpm, Go and Rust. Anything else goes in a recipe, `~/.anchi/images/<id>.yaml` with `packages:` and `run:`, used with `image: <id>`.

## What happened, and what it cost

```bash
anchi audit <task>          # hosts the task's cells contacted, credentials injected, refusals, held writes
anchi access --since 7d     # the same across every agent
anchi usage --by agent      # tokens by agent, model, runtime or day; subscription limits last seen
anchi scan <task>           # look for real credential values in a live cell (should find none)
```

In the TUI, **^X l** shows the access report of the task on screen. A host refused by an agent's `egress` list can be allowed with `anchi agents allow-host <agent> <host>` (exact host), only after the user agrees (rule 3).

## Daemon and maintenance

```bash
anchi daemon status | start | stop
anchi daemon install          # start the daemon at login (launchd / systemd user unit)
anchi update                  # install the latest release; --check only checks
anchi setup vm                # start a stopped VM, then: anchi setup vault unlock
```

`anchi setup install` is safe to run again (it updates the VM's components) but refuses while task cells are live. `anchi setup reset` deletes the VM and everything in it, and refuses while tasks run or wait; `--all` also deletes the vault key and `~/.anchi` (keeping `keybindings.json`).

## More

- [references/cli.md](references/cli.md): every command and flag.
- [references/agent-config.md](references/agent-config.md): agent files, templates, recipes, settings.
- [references/tui.md](references/tui.md): the TUI's screens and keys.
- [references/troubleshooting.md](references/troubleshooting.md): errors and their fixes.
- Limits to tell the user about: credential isolation is not data isolation (what an agent reads can reach its model and any host it may contact); Anchi is a development preview without a security audit.
