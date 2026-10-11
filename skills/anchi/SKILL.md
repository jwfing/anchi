---
name: anchi
description: Operate Anchi, a secured agent team on your own computer — set up its VM and vault, connect runtimes (Codex, Claude Code, Hermes) and accounts, define agents in YAML, run tasks, delegation, triggers, skills, workspaces, egress limits, approvals, audit and usage, from the `anchi` CLI or TUI. Use when the user mentions Anchi or 安栖, wants to create or change an Anchi agent, give one a task, see what an agent accessed, handle a held write, or fix an Anchi setup.
---

# Using Anchi

Anchi runs a team of agents (Codex, Claude Code or Hermes) on the user's computer. Each task runs in a disposable cell inside a local Linux VM (`anchi-vm`, through Lima). Agents never hold credentials: an egress proxy in the VM injects GitHub, AWS, Linear and model credentials on the way out, and trusted services in the VM act for agents on Gmail, Drive, Notion and Slack. Each agent reaches only the connectors, hosts, directories, skills and delegates in its YAML file.

Two front ends talk to one background daemon: the full-screen TUI (`anchi`) for people, and the CLI (`anchi <command>`) for scripts and agents. From a source checkout the CLI is `scripts/anchi`.

## Rules for an agent operating Anchi

1. **Never handle the user's secrets.** Tokens, API keys and Google sign-in are entered by the user: `anchi setup …` reads them without echo, the TUI uses masked dialogs. Do not ask the user to paste a secret into the chat, do not pass one on a command line or in a file, and never `cat` anything under `~/.config/anchi/`.
2. **Never approve or deny a held write for the user.** `anchi approve <id>` exists for the user. Show them `anchi approvals` and let them decide, unless they explicitly told you to approve that specific write.
3. **Destructive commands need the user's go-ahead**: `anchi setup reset`, `anchi agents rm`, `anchi rm <task>`, `anchi setup disconnect`. Do not add `-y` to skip their confirmation unless the user asked for it.
4. **Prefer editing agent files over the TUI** when you work non-interactively: they are plain YAML in `~/.anchi/agents/`, and the daemon reloads them on change. Keep the user's comments.
5. **Report what Anchi says.** Errors carry a hint (`HERMES_NOT_CONFIGURED: set its OpenAI-compatible endpoint …`); pass it on instead of guessing.

## First run

```bash
curl -fsSL https://anchi.elseward.xyz/install.sh | sh    # macOS (Apple Silicon) or Linux x86_64
anchi                                                      # opens Getting started in the TUI
```

Prerequisites: macOS needs `brew install lima python`; Linux needs Lima 2.2+, Python 3.11+, QEMU and access to `/dev/kvm`. Then, in order (each also in the TUI's **Runtimes** screen):

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

A runtime is installed into the cell image the first time one of its agents runs a task (a few minutes, once).

## Agents

An agent is `~/.anchi/agents/<id>.yaml` (id: lowercase letters, digits, `-`). Minimal:

```yaml
name: Developer
runtime: codex                       # codex | claude-code | hermes
connectors: [github]
prompt:
  text: Fix the GitHub issue you are given, push a branch and open a pull request.
```

Every field, with examples, is in [references/agent-config.md](references/agent-config.md). The ones that bound what an agent can do: `connectors`, `egress`, `workspaces`, `approvals`, `delegates`, `accounts`, `highRisk`. Unknown fields are errors; `anchi agents` shows each agent and any error in its file.

People usually create agents with the **Agent builder** in the TUI (**^X b**): they describe the agent, the builder proposes a file, and a full-screen dialog shows it before anything is written. **^X s** opens an agent's settings panel (runtime, model, prompt, skills, connectors, workspaces), which also shows a diff before saving.

## Tasks

```bash
anchi run dev "Fix issue #42 in acme/api"     # start a task and stream it until the turn ends
anchi tasks                                   # newest first; -a <agent> -s running -q <words> --since 24h
anchi send <task> "Also add a test"           # a follow-up turn in the same session
anchi retry <task>                            # continue a failed or cancelled task; --fresh starts over
anchi cancel <task>
anchi rm <task>                               # delete a finished task and the tasks it delegated
```

`-v` on `run`, `send` and `retry` shows tool output. A task id looks like `t-…`. Tasks of one agent can run in parallel; each has its own cell and session.

## Accounts (connectors)

| Connector | Connect | Agents reach it |
|---|---|---|
| GitHub | `anchi setup connector github` (fine-grained PAT) or `--from-gh` | `gh`, git over HTTPS, the API; the proxy injects the token |
| AWS | `anchi setup connector aws` (keys) or `--profile <sso-profile>` | AWS CLI and SDKs; the proxy re-signs requests; credential minting is denied |
| Linear | `anchi setup connector linear` | The GraphQL API; the proxy injects the key |
| Gmail, Drive | `anchi setup service gmail [--account work]` (Google sign-in in the browser) | Tools in the cell (`gmail_*`, `drive_*`); Gmail is read-only |
| Notion, Slack | `anchi setup service notion` / `slack` (token) | Tools in the cell (`notion_*`, `slack_*`) |

An agent gets a connector only if its file lists it. Several Google accounts: connect each with `--account <name>` and pick one per agent with `accounts: { gmail: work }`. `anchi setup service-mode notion ask` makes every Notion write of every agent wait for approval. `anchi setup disconnect <id>` removes a credential.

## Approvals

Writes wait for the user when the agent's file says `approvals: { github: ask }` (per connector), and always for high-risk operations (merging a PR, deleting or reconfiguring a repository, pushing to `main`, AWS deletions, Linear deletions…) unless `highRisk: { disable: [...] }` exempts them.

```bash
anchi approvals          # what is waiting, with the task's origin chain
anchi approve <id>       # the user's decision — see rule 2
anchi deny <id>
```

In the TUI, a held write opens a full-screen dialog (**^X a** to review). Unanswered writes are refused after five minutes (connector services: ten).

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

In the TUI, **^X l** shows the access report of the task on screen. A host refused by an agent's `egress` list can be allowed with `anchi agents allow-host <agent> <host>` (exact host) after the user agrees.

## Daemon and maintenance

```bash
anchi daemon status | start | stop
anchi daemon install          # start the daemon at login (launchd / systemd user unit)
anchi update                  # install the latest release; --check only checks
anchi setup vm                # start a stopped VM, then: anchi setup vault unlock
```

`anchi setup install` is safe to run again (it updates the VM's components) but refuses while task cells are live. `anchi setup reset` deletes the VM and everything in it; `--all` also deletes the vault key and `~/.anchi`.

## More

- [references/cli.md](references/cli.md): every command and flag.
- [references/agent-config.md](references/agent-config.md): agent files, templates, recipes, settings.
- [references/tui.md](references/tui.md): the TUI's screens and keys.
- [references/troubleshooting.md](references/troubleshooting.md): errors and their fixes.
- Limits to tell the user about: credential isolation is not data isolation (what an agent reads can reach its model and any host it may contact); Anchi is a development preview without a security audit.
