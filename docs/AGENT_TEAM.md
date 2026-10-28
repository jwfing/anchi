# Agent team

Anchi runs a secured team of Codex, Claude Code and Hermes agents. Each task runs in a disposable cell inside the `anchi-vm` VM, and each agent gets only the connectors, hosts, directories, skills and delegates in its configuration. Credentials stay in the VM vault: an egress proxy adds GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord and model credentials to the agent's requests on the way out, and trusted services act for it on Gmail, Drive, Notion, Slack, X and Reddit. This guide covers installation, connecting accounts, creating agents and running tasks. The design is in [Agent team design](architecture/AGENT_TEAM_DESIGN.md), the interfaces are in [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md), and the boundaries are in [Security](../SECURITY.md#agent-team-task-cells-and-the-egress-proxy).

## Install

Install Anchi and prepare its VM with [Getting started](GETTING_STARTED.md). This guide uses
the installed `anchi` command. From a source checkout, use `scripts/anchi` instead; only source
development needs Node and pnpm. With no arguments, `anchi` opens the TUI.

`anchi setup install` creates or updates the VM and refuses while task cells are live (cells
can remain alive for 10 minutes after a task turn; an image build under way counts too). `anchi setup vm` starts a stopped VM;
`anchi setup vault unlock` unlocks it. Back up `~/.config/anchi/vault.key`: a replacement key
cannot recover stored credentials. `anchi daemon install` starts the daemon at login.

## Connect accounts

For Reddit, see [Reddit setup](REDDIT_SETUP.md): use an approved Data API installed app, sign in
in the browser and enable `reddit` for the agent. Reads are bounded; posts and comments wait for
approval of the full content, destination and verified account unless you set Reddit writes to
`auto`.

For X, see [X setup](X_SETUP.md): configure your native app Client ID, authorize in the browser,
and enable `x` for the agent. Reading/search/mentions are bounded; publishing text or replies
waits for approval of the full text and verified account unless you set X writes to `auto`.

Anchi detects local Codex and Claude Code subscription logins at startup and imports available
access tokens automatically once the VM and vault are ready. Both are imported when present.
An installed CLI without a usable login still needs local sign-in. No model is called by import.

Codex uses your ChatGPT subscription. Log in on the host with `codex login`. To import manually:

```bash
anchi setup codex
```

This stores the access token and account id in the vault. The refresh token stays with the Codex CLI on the Mac. Afterwards the daemon keeps the vault current: when the Codex CLI on the Mac has refreshed its login, the daemon imports the newer access token for the same account (checked on every change of `~/.codex/auth.json` and every five minutes). Set `codexAutoImport: false` in `~/.anchi/settings.yaml` to import only by hand. If the Mac has not used Codex for a while, run `codex` once to refresh its login.

Claude Code imports the `claudeAiOauth.accessToken` from its macOS Keychain entry or
`~/.claude/.credentials.json` on Linux (also the macOS fallback). `CLAUDE_CONFIG_DIR` selects
a separate file and Keychain entry. Only the access token and expiry go to the vault; the
refresh token stays with Claude Code on the host. Anchi checks file changes and polls every
five minutes for newer tokens. Expired logins require opening Claude Code locally to refresh
or sign in again. macOS can ask for Keychain access. This follows Claude Code's
[credential storage](https://code.claude.com/docs/en/authentication#credential-management).

Set `claudeAutoImport: false` in `~/.anchi/settings.yaml` to disable automatic Claude imports.
Anchi preserves a manually supplied Claude token/API key and does not replace it with a host
login. For a manual long-lived subscription token or an Anthropic API key:

```bash
claude setup-token          # on the Mac; prints a token
anchi setup claude          # paste it, without echo
```

Agents with `runtime: claude-code` then run Claude Code in their cells with a placeholder; the proxy substitutes the token on `api.anthropic.com`.

[Hermes Agent](https://github.com/NousResearch/hermes-agent) runs on an OpenAI-compatible endpoint you choose (OpenRouter, Together, a self-hosted vLLM behind HTTPS…): its base URL, an API key and a default model.

```bash
anchi setup hermes --base-url https://openrouter.ai/api/v1 --model nousresearch/hermes-4-405b
# then paste the API key, without echo; or press h in Runtimes
```

The key stays in the vault. Agents with `runtime: hermes` run Hermes with a placeholder key, and the proxy substitutes the real one under the base URL only — that host, that path prefix; account administration paths there (`/organization`, `/dashboard`) are refused. The endpoint must be HTTPS on a public name that no other rule uses (not `api.anthropic.com`, `api.github.com`, AWS or `chatgpt.com`). `model` in an agent file picks another model of the same endpoint. Hermes's own command and edit approvals are off in cells, as for the other runtimes: the cell is the boundary. Storing a new endpoint applies to new tasks; a running task's cell keeps sending to the endpoint it started with, and the proxy refuses to send the new key there.

Each runtime is installed in the cell image the first time one of its agents starts a task (a notice says so; a few minutes, once), not by `setup install`. A runtime you never use is never downloaded.

Connectors:

```bash
anchi setup connector github             # fine-grained token, prompted without echo
anchi setup connector github --from-gh   # or the token of the gh CLI (broader scopes)
anchi setup connector linear             # API key
anchi setup connector posthog            # personal API key (phx_…), US or EU Cloud
anchi setup connector sentry             # user auth token (sntryu_…)
anchi setup connector firecrawl          # API key (fc-…)
anchi setup connector figma              # personal access token (figd_…)
anchi setup connector discord            # bot token
anchi setup connector aws                # keys of a dedicated IAM principal and a region
anchi setup connector aws --profile dev  # or a profile on this Mac, such as AWS SSO
```

With `--profile`, the daemon exports the profile's temporary credentials with the AWS CLI on the Mac (`aws configure export-credentials`) and imports them again before they expire. The AWS CLI refreshes the SSO token while the SSO session lasts; when it ends, the daemon shows a notification and you run `aws sso login --profile dev`. In the TUI, **Connectors** offers `g` (GitHub from gh) and `p` (AWS profile).

Each command checks the credential with the service and prints the account it belongs to. A credential the service refuses is not kept. Run these commands in a terminal: they prompt for the secret without echo. They also read the secret from stdin when stdin is not a terminal. For AWS, stdin takes JSON: `{"accessKeyId", "secretAccessKey", "region", "sessionToken"?}`. In the TUI, the same setup is under **Connectors** and **Runtimes**.

Gmail, Drive, Notion and Slack are trusted services in the VM. Agents with these connectors call them through Anchi tools; the services' own policy decides each request.

```bash
anchi setup google-client ~/Downloads/client.json  # once, unless Anchi ships a built-in client
anchi setup service gmail      # Google sign-in in the browser (read-only scope)
anchi setup service gmail --account work   # a second Google account, named "work"
anchi setup service drive
anchi setup service notion     # internal integration secret, without echo
anchi setup service slack      # bot token
anchi setup service-mode notion ask   # every Notion write waits for your approval
```

Google tokens are obtained in the VM from the authorization code; they never reach the Mac. In the TUI, the **Services** part of **Connectors** does the same (`Enter` connect, `m` write mode, `d` disconnect).

Gmail and Drive can each hold several Google accounts, by name (`default` unless you pass `--account`). An agent uses `default` unless its file names another one, for connectors it has:

```yaml
connectors: [gmail, drive]
accounts: { gmail: work }       # Drive stays on `default`
```

The account is pinned to the agent's cells by the bridge in the VM; the agent cannot ask for another account, and approvals bind to the account they were given for. `anchi setup disconnect gmail --account work` disconnects one account.

Grant only what agents need. [Token connectors](CONNECTORS.md#token-connectors) says where to create each credential and which scopes to give it.

Agents see each credential as a placeholder environment variable: `GH_TOKEN`, `LINEAR_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, `SENTRY_AUTH_TOKEN`, `FIRECRAWL_API_KEY`, `FIGMA_ACCESS_TOKEN`, `DISCORD_BOT_TOKEN`, and AWS's variables. The proxy injects the real one into requests to that service's API only.

The proxy denies credential minting (GitHub keys and installation tokens, AWS STS/IAM key and session creation, Linear API keys, PostHog personal API keys and project token resets, Sentry token creation, Discord webhooks, whose objects carry their own token), but any other permitted call acts with the full authority of the credential.

## Create agents

### Create a starter

`anchi agents create dev --runtime claude-code` previews a minimal agent and asks before saving.
Choose `codex`, `claude-code` or `hermes`; no Codex login or model call is needed for creation.
`--preview` prints the YAML without saving; `--yes` saves without prompting after you review it.
Existing ids are refused, including a file created after preview. In the TUI, **Ctrl+X, N**
chooses the runtime and id, then opens the same proposal review used by the builder.

The starter explicitly sets `connectors: []` and `workspaces: []`. It leaves `egress` out, so the
agent reaches any public host, and `maxTasks` at its default of 3. Add connectors and directories
deliberately in the settings or agent file; add an `egress` list only to limit the hosts.
See [First task](FIRST_TASK.md) for a complete example.

### Use Agent builder

Open the TUI, select **Agent builder**, and describe the agent: its job, the services it needs and the tools it uses. The builder runs on the first connected runtime (Codex, then Claude Code, then Hermes), so one connected runtime is enough; `builderRuntime: claude-code` in `~/.anchi/settings.yaml` picks one, and the builder's view shows which it uses. A builder conversation keeps the runtime it started on. Each turn, the builder is told what exists: installed skills, connectors and whether they are connected, directories under `~/AnchiWorkspaces`, agents and images. It replies with a proposal. A full-screen dialog shows:

- the agent file;
- an image recipe, if the agent needs tools beyond the [base image](#base-image);
- what blocks it (a skill that is not installed, a directory that does not exist, an unknown delegate) and what is worth knowing (a connector not connected yet).

Press `y` to write the files, `n` to discard the proposal, or `s` to change its settings yourself in the settings panel; the proposal is checked again and shown with your changes.

The builder can also change an existing agent. Each turn it gets a one-line summary of every agent, and the agent file of each agent your message names by id (`dev` or `@dev`; up to 4 KB per file). For a change it proposes a patch with only the fields to change: name, description, runtime, model, effort, prompt, skills, connectors and workspaces. The dialog shows the change as a diff of the agent file, and the rest of the file, comments included, stays as it is. If the file changes before you press `y`, the patch is refused; ask the builder again. For other fields (triggers, approvals, egress, delegates, image), the builder proposes the whole file, which replaces the old one. The builder cannot write any file itself.

### Write an agent file

Agents are YAML files in `~/.anchi/agents/`, and recipes are in `~/.anchi/images/`. You can also edit them directly; the daemon reloads them on change. See [Agent configuration](architecture/AGENT_TEAM_CONTRACTS.md#agent-configuration).

For a first task on a released binary, create `~/.anchi/agents/dev.yaml` in your editor (make
`~/.anchi/agents` if absent; choose another id if `dev` already exists):

```yaml
name: Developer
runtime: claude-code   # or codex / hermes; use the runtime you connected
connectors: []
workspaces: []
prompt:
  text: Help with the requested task. Explain missing access instead of trying to bypass it.
```

Run `anchi agents` to check it, then `anchi run dev "Explain what tools you have access to. Do not change anything."`.

The following example needs a connected GitHub account; the team examples with Linear,
approvals, triggers and a `triage` skill come under
[Teams, approvals, triggers and skills](#teams-approvals-triggers-and-skills):

```yaml
# ~/.anchi/agents/dev.yaml
name: Developer
runtime: codex
connectors: [github]
prompt:
  text: Fix the GitHub issue you are given, push a branch and open a pull request.
```

### Base image

Every agent's cells start from the built-in base image (`codex`), with its runtime's layer on top (Codex, Claude Code or Hermes, built the first time an agent of that runtime runs). The base is Debian 12 with common developer tools, so coding agents work without a recipe:

| Tools | Notes |
|---|---|
| git, gh, curl, jq, ripgrep (`rg`), fd, sqlite3, zip, unzip, tree | |
| build-essential (gcc, make), pkg-config, libssl-dev | Native modules and crates |
| Python 3 with pip and venv | `python3 -m venv .venv` in the work directory |
| Node.js 22, npm, pnpm | Pinned in `guest/cell.env` |
| Go | `GOPATH` and the build cache are in the agent's home |
| Rust (rustc, cargo, clippy, rustfmt) | The toolchain is read-only in `/opt/rustup`; `~/.cargo` holds the registry cache and `cargo install` output. A repository that pins another toolchain needs an image recipe |

Versions are pinned and checked by hash in `guest/cell.env`. Changing `guest/anchi-build-base.sh` or a pin it reads makes a new base: the next task builds it (a few minutes; `anchi setup install` builds it right away), and the runtime layers and image recipes are rebuilt on it. Changing a runtime's script (`guest/anchi-build-runtime-<runtime>.sh`) or its pins rebuilds only that runtime's layer. Dependencies are downloaded at task time through the egress proxy, so an agent with an `egress` list needs its registries: `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`, `proxy.golang.org` and `sum.golang.org`, `index.crates.io` and `static.crates.io`. Tools beyond these go in an image recipe:

```yaml
# ~/.anchi/images/db.yaml
description: PostgreSQL client
packages: [postgresql-client]
```

## Agent settings

**^X s** in an agent's chat (or **s** on it in the sidebar) opens its settings panel. It lists the agent's name, description, runtime (marked connected or not), model, effort and prompt, then every installed skill, every connector (marked connected or not), every directory under `~/AnchiWorkspaces` and the high-risk operations of the agent's connectors. **Space** changes the selected row:

- on name, description or model, you type the new value (an empty model means the runtime's default);
- runtime goes through `codex`, `claude-code` and `hermes`, and effort goes through unset, `low`, `medium`, `high` and `xhigh` (only Codex uses it);
- the prompt mode switches between `append` and `replace`, and the prompt text opens in `$EDITOR`;
- skills and connectors are selected or deselected, and a workspace goes off → `ro` → `rw`;
- a high-risk operation marked `[x]` is one the agent does without asking you (`highRisk.disable` in its file; see the approvals section below). A row says when `~/.anchi/settings.yaml` already exempts it for every agent, or when the agent's `approvals: {<connector>: ask}` holds it anyway. The review lists each new exemption as a warning.

At the bottom, the panel shows what it cannot change: template, image, sandbox, delegates, approvals, egress and triggers, and whether the agent's X posts and Reddit posts and comments ask, go out without approval, or follow the service's mode. Edit those in the agent file. For an agent that `extends` a template, an inherited value is marked `from template <id>`. Changing an inherited value writes an override into the agent's own file. A prompt that comes from `prompt.file` is read-only in the panel; edit that file instead.

**Enter** shows the change to the agent file as a diff, checked like a proposal. Errors block saving, for example `sandbox: codex-workspace-write` with runtime `claude-code`. Warnings, such as a runtime that is not connected yet, do not block. **y** saves the change. Only the fields you changed are written; an emptied model, effort or description removes its key. The rest of the file, comments included, stays as it is. The change applies to the agent's next cell. After a runtime change, a task whose session started on the previous runtime cannot continue — another runtime cannot resume that session — so replies to it are refused; start a new task, or run a failed one again with `anchi retry --fresh`.

## Delete an agent

**D** on the agent in the sidebar, **D** in its settings panel, **^X D** in its chat, or `anchi agents rm <id>`. A dialog lists what goes and what stays; type the agent's id to confirm. Deleting:

- removes the agent file;
- deletes all its tasks and transcripts, with the tasks they delegated to other agents; running and queued ones are cancelled first. A task of another agent that had delegated to it stays, with a note;
- forgets its triggers and what its polls have seen;
- removes it from other agents' `delegates` and from the `delegates` of templates in `~/.anchi/templates/`, keeping the rest of their files (an agent that only inherited it is not edited);
- in the VM, removes its home (work directory, Codex and Claude sessions), its skills and its policy rules.

Directories of your computer in `~/AnchiWorkspaces` are not touched: they are only bound inside the agent's cells, and the VM refuses the removal while the agent has a cell or anything under its home is a mount point. Audit logs are kept. If the VM is not running, the rest is done and the dialog says so; deleting the agent again later finishes the VM part. The builder cannot be deleted.

## Teams, approvals, triggers and skills

A team can span local and remote machines: keep one daemon as its coordinator and add members
with `anchi team add <id> --node <saved-server> --agent <remote-id>` or **Agent builder → Run
on** in the desktop app. Members still delegate by logical agent id, and their task tree,
results, usage and approvals appear together. Credentials and execution policy stay on the
chosen node. See [One team, multiple execution nodes](REMOTE_SERVER.md#one-team-multiple-execution-nodes)
for setup, grants, recovery and file-sharing limits.

```yaml
# ~/.anchi/agents/lead.yaml
name: Lead
runtime: claude-code
connectors: [linear, github]
delegates: [developer]          # may hand tasks to these agents
approvals: { github: ask }      # its GitHub writes (push, PR, comments) wait for you
skills: [triage]
triggers:
  - poll: { type: linear-issues, label: agent }
    text: "Triage {title} ({url}) and delegate the fix"
  - schedule: '0 9 * * 1-5'
    text: Summarize yesterday's merged pull requests
```

```yaml
# ~/.anchi/agents/merger.yaml — an agent whose job is merging approved pull requests
name: Merger
runtime: codex
connectors: [github]
highRisk: { disable: [github-merge] }  # merging does not wait for you; no approvals here,
                                       # since `github: ask` would hold the merge anyway
```

- **Delegation.** An agent with `delegates` gets the tools `anchi_delegate_task`, `anchi_task_status`, `anchi_send_to_task` and `anchi_list_tasks`. A delegated task runs in its own cell with its own connectors; the parent waits for its result. Delegation stops at three levels, ten children per task and sixty turns per tree, and an agent cannot be asked to work on a task above its own.
- **Approvals.** Without `approvals`, ordinary writes go straight through; listed high-risk operations (below) wait by default unless exempted. With `approvals: {<connector>: ask}` for a proxy connector, the proxy holds the agent's writes: git push, GitHub API writes and mutations, AWS operations other than reads, Linear mutations (a GraphQL document is a mutation when a `mutation` operation appears anywhere at its top level, and one the proxy cannot read counts as a write), and for PostHog, Sentry, Firecrawl, Figma and Discord every request other than `GET` (except PostHog queries, which are reads; every Firecrawl scrape, crawl and search counts, since each spends credits). A full-screen dialog shows the git refs or the start of the request; choose `y` to allow or `n` to refuse, then press **Enter** to confirm. The sidebar's **Approvals** view (**^X 5**) lists every pending write with the same details and keys, so you can work through them in one place. Each write that starts waiting raises a desktop notification (macOS; Linux with `notify-send`), also while the TUI is open; `desktopNotifications: false` in `~/.anchi/settings.yaml` turns desktop notifications off. An unanswered write is refused after five minutes (`approvalTimeoutMinutes: 30` in `~/.anchi/settings.yaml` waits longer, up to 720; the held request stays open in the proxy meanwhile, and the agent's own tool may give up first). For Gmail, Drive, Notion and Slack, `ask` holds the agent's writes in the service's own policy (`notion:writer`), alongside each service's write mode, which applies to every agent; reads follow the service's mode, and these approvals expire after the policy service's ten minutes whatever `approvalTimeoutMinutes` says. X and Reddit differ: their reads are always automatic, their write mode defaults to `ask`, and an agent's `approvals: {x: auto}` (or `reddit: auto`) lets that agent post without approval even while the service asks. Such an agent posts publicly under your account without a person, also in triggered tasks that read untrusted content; see [X setup](X_SETUP.md). It needs the guest components of this release (`anchi setup install`): an older guest refuses the cell (`USAGE`). `anchi approvals`, `approve ID` and `deny ID` do the same from the CLI.
- **Listed high-risk operations ask by default**, for every agent and every task origin, whatever its `approvals`: merging a pull request, deleting, transferring or reconfiguring a repository, branch protection, collaborators, webhooks and deploy keys, deleting a branch, pushing to `main` or `master`, AWS deletions, terminations and access changes, Linear deletions, deleting PostHog or Sentry organizations, projects and teams and changing their members, Figma webhooks (they send future events to a URL), deleting Discord channels or servers, banning, kicking or changing members' roles, and changing Discord roles, channel permissions, server or bot settings. The dialog says why the write is held and how the task started (`poll → @lead (t-…) → @developer (t-…)`). Switch entries off for every agent in `~/.anchi/settings.yaml` (`highRisk: { disable: [github-merge] }`), or for one agent in its file with the same field (or **Space** on the operation in its settings panel): the merge agent above merges without asking while other agents still ask. `approvals` take precedence: `ask` holds every write of its connector, so an agent with `approvals: { github: ask }` and `highRisk: { disable: [github-merge] }` still waits for you before a merge — give the exception to an agent without `approvals` for that connector. The ids: `github-merge`, `github-repo-delete`, `github-repo-settings`, `github-repo-transfer`, `github-protection`, `github-access`, `github-ref-delete`, `github-graphql`, `git-default-branch`, `git-ref-delete`, `aws-destroy`, `aws-s3-delete`, `aws-s3-access`, `linear-delete`, `posthog-delete`, `posthog-access`, `sentry-delete`, `sentry-access`, `figma-webhook`, `discord-delete`, `discord-members` and `discord-access` (`services/egress_rules.py`); an unknown id is an error in the agent file. A task's access report shows the agent's exceptions. `highRisk` in an agent file needs the guest components of this release: run `anchi setup install` (**Runtimes**, `I`) after updating, since an older guest refuses the cell (`USAGE`) rather than starting it without the exception. The proxy cannot tell a force-push from a fast-forward, so it holds pushes to the default branch names rather than force-pushes.
- **Egress.** `egress: [registry.npmjs.org, '*.pypi.org']` limits the hosts an agent's cells reach; its runtime and connectors' hosts are always allowed (for Codex: `chatgpt.com`, `*.chatgpt.com` and OpenAI's content CDN `*.oaiusercontent.com`). Other connections fail and are audited as `egress-denied`, and the task notes each refused host once while it runs. To allow one, press **^X l** in the task's view, then **e**, choose the host and confirm (or `anchi agents allow-host <agent> <host>`): the exact host is added to the agent's `egress`, from its next cell on. Wildcards are added by editing the file. Without `egress` the agent reaches any public host. An allowed host can still receive data (a gist on `github.com`), so a list narrows exfiltration; it does not end it.
- **Triggers.** `schedule` takes a cron expression in local time; an expression that does not parse (`0 25 * * *`, names like `MON-FRI`) or a blank `text` is an error when the agent file loads. A run missed while the Mac slept runs once on wake. `poll` checks Linear issues (by `team`, `label` or `state`) or a GitHub issue search (`query`) every `every` minutes (default 5) and starts one task per new item; items that existed when the trigger was added are skipped. `anchi triggers` lists them, with a trigger's last error where its result would be.
- **Skills.** `anchi skills add <directory or GitHub URL> [--id x]`, or **a** on the **Skills** screen, stores a `SKILL.md` skill; a GitHub skill is pinned to the commit it was fetched at. A directory or repository without a top-level `SKILL.md` is a collection: each `<name>/SKILL.md` and `skills/<name>/SKILL.md` in it is added under `<name>` with its own tree URL (for example `anchi skills add https://github.com/addyosmani/agent-skills`), and a skill that cannot be added is skipped and reported. Give it to agents in their settings panel (**^X s**) or with `skills: [id]`; their cells get it read-only. An agent can have up to 200 skills, at most 8 MB and 2000 files together. `anchi skills update [id]`, or **u** on the Skills screen, shows what the latest commit of the URL changes (files added, changed, removed) and installs exactly that commit after you confirm. The screen lists one line per skill — its id and where it came from (`owner/repo @ commit`, or `local`) — with the skills of one repository together and local ones last; it shows how far down the list you are (`12/25`), scrolls with the cursor (**↑ ↓**, **PgUp PgDn**, **Home End**) and shows the selected skill's description below the list. Skill content is untrusted, like any other agent input.

## Directories of your computer (workspaces)

Share `~/AnchiWorkspaces` with the VM once (it restarts the VM and unlocks the vault again; on Linux it also reinstalls the guest components, see [Linux differences](GETTING_STARTED.md#linux-differences)):

```bash
anchi setup workspaces      # or W on the Runtimes screen
```

Then give an agent directories under it:

```yaml
workspaces:
  - path: projects/webapp   # ~/AnchiWorkspaces/projects/webapp
    mode: rw                # ro by default
```

They appear in the agent's cells at `/home/agent/workspaces/<name>`; a cell sees no other directory of your computer. Writes to an `rw` workspace go straight to your computer and are owned by you. Anchi tells the agent where they are and what they map to, and that its own working directory, `/home/agent/work`, stays in the VM: files there are not on your computer. An agent that cloned a repository into `/home/agent/work` before it had a workspace may keep using that copy; ask it to work in the workspace, or to push its branch. A workspace is slower than `/home/agent/work` for many small files, much more so on Linux hosts (9p): agents are told to keep dependencies, virtual environments, caches and build output in `/home/agent/work`.

A writable directory lets an agent leave code that your own tools later run. Anchi mounts git hooks, git configuration and info, `.gitattributes`, `.envrc`, `.vscode/` and `.idea/` read-only in the repositories near the top of an `rw` workspace. After each turn it compares the workspace with its state before the turn and notes in the task transcript any new git hook, git configuration that runs commands, symlink pointing outside the workspace, new executable file or changed editor or shell configuration. It never changes your files. Files that tools run by design, such as `package.json` scripts or a `Makefile`, cannot be masked: review an agent's changes before you run them.

## Run tasks

In the TUI, select an agent and type a task. **Enter** starts it. Each message in an agent's view starts a new task (a new Codex or Claude session), so you can hand an agent several tasks in a row; the view lists the agent's tasks, the running ones with what they are doing. Open a task (click it there, or select it in the sidebar) to talk to it: the input in a task's view replies to that task, in its session. The agent builder is the exception: its view is one conversation, as before.

An agent runs up to three of its tasks at the same time; more wait in its queue. Set `maxTasks: 1` to `10` in the agent file to change that (`maxTasks: 1` runs them one after another). A task takes one turn at a time: a reply waits until the running turn ends. Across all agents, at most four cells work at once (`maxCells` in `~/.anchi/settings.yaml`); a task waits for a free one. A cell whose turn is waiting for a task it delegated does not count, so the delegated task can run, and waiting delegated tasks get a free cell before new ones.

- Keyboard and mouse do the same things. **Tab** (or a click) moves between the sidebar and the main pane; the pane with the keys has a cyan border. In the sidebar, **↑ ↓** move, **1 2 3** jump to Configure, Agents and Tasks, **[ ]** turn task pages and **Enter** opens the item. In the main pane, **Esc** goes back to the sidebar; the draft and a running turn are kept.
- Every action is also reachable through the leader key **Ctrl+X** and one more key; a panel shows what can follow. **^X Space** opens the command palette and **^X ?** lists the keys of the current view; both stay at the right of the status line. To copy text, **^X m** turns on selection mode: the mouse goes back to the terminal, which selects and copies the transcript without borders or the sidebar. Keys can be changed in `~/.anchi/keybindings.json`: see [Key bindings](KEYBINDINGS.md).
- A task runs in a fresh cell. Follow-up messages reuse the cell until it has been idle for 10 minutes; after that, the next message resumes the agent's Codex or Claude Code session in a new cell.
- Before a cell is destroyed (idle timeout, cancellation, daemon shutdown), it is scanned for real credential values; the task notes `scan: clean`, and a finding raises a notification.
- A failed or cancelled task can run again: **^X r** in its view (or `anchi retry <task>`) either continues its session, telling the agent why the last turn stopped so it keeps the work it had done, or starts over as a new task with the same request (`--fresh`).
- **^X n** in a task's view goes to its agent's view, for a new task. In the builder's view it starts a new conversation; **Enter** otherwise continues the one shown.
- The input edits like a shell line (**Ctrl+A**, **Ctrl+E**, **Ctrl+W**, **Ctrl+U**, arrows). **Ctrl+G** (or **^X e**) composes the message in `$EDITOR`, which helps if your terminal's IME misbehaves.
- The sidebar has three sections: **Configure** (runtimes, skills, connectors), **Agents** (the builder and your agents) and **Tasks** (every task, newest first, in pages). Select a task to see its status, times, links and transcript, with an input to reply to it; **^X r** runs a failed one again, **^X c** cancels it, **^X D** deletes it. In the sidebar, **[** and **]** turn the page. Clicking works too. The sidebar lists the newest 500 tasks; older ones are reachable with `anchi tasks` (`--since`, `--search`).
- **^X l** in a task's view shows its external access: see [Access and usage](#access-and-usage).
- Consecutive tool calls fold into one line: while the turn runs it shows the count and the latest call; afterwards a click (or **^X t**) expands the list.

The CLI does the same:

```bash
anchi run dev "Fix https://github.com/me/repo/issues/12"
anchi send t-0123456789 "Also add a test"
anchi tasks --status failed --since 7d --search login
anchi rm t-0123456789       # delete a finished task and the tasks it delegated
anchi scan t-0123456789     # credential-invariant scan of the live cell
anchi audit t-0123456789    # what the task reached outside, and with which credentials
anchi usage --since 7d --by model
```

Each agent has a persistent home in the VM, `/var/lib/anchi/agents/<id>/home`. It is mounted at `/home/agent` in the agent's cells and holds the work directory and Codex sessions. Everything else in a cell is discarded when the cell ends.

## Access and usage

**A task's access.** The egress proxy writes a row for every request a cell makes, every cell registration and every bridge call. **^X l** on a task (`anchi audit <task> [--json]`) reads the task's rows from the VM and shows:

- A headline that checks the boundary, for example "42 requests; 17 with credentials injected by the proxy; the cell sent only placeholders or no credential; 2 refused or held; scan: clean". It turns red when a cell sent a credential of its own (something other than a placeholder) to a host.
- The scope of the cell: connectors, bridge services, egress list and the writes it holds.
- The hosts requested, with a count of each decision (`inject`, `pass`, `deny`, `egress-denied`, `host-mismatch` for a request whose `Host` header named another host than its connection, …).
- The requests refused or held, with the outcome of each approval.
- Gmail, Drive, Notion and Slack calls through the bridge.
- The latest requests (method, host, path, decision). Query strings and header values are never recorded.

Hosts and paths come from the agent's requests, so they are shown as agent text. The VM keeps the log up to 50 MB and one rotated file. The daemon saves a task's rows when each of its cells closes and whenever they are read (up to 5,000 per task), so a task's record outlives the rotation and goes when the task is deleted. If the VM cannot be read, the view shows the saved rows and says so.

**Every agent's access.** **Configure → Access** (`anchi access [--since 24h|7d|30d] [--json]`) sums up the saved rows of all tasks over a period: per agent its tasks, requests, hosts, refusals, held writes and the credentials the proxy injected by connector; the hosts most requested and by whom; every request where a cell sent a credential of its own; and the latest refusals. **p** changes the period and **r** refreshes. Rows of running tasks are read from the VM when the screen opens.

**A credential of the cell's own.** Anchi's credentials never enter a cell; the cell sends placeholders, and the proxy replaces them. When a cell sends something else in `Authorization` or `x-api-key` (a key from the task text or a file, for example), the proxy tells the daemon at once: the task gets a ⚠ note naming the host, and a desktop notification goes out, once per host and cell. Every such request is in the access view, and its headline turns red.

**Token usage.** Every turn's tokens are recorded with the agent, runtime and model: input, cached input, output and reasoning tokens, and Claude Code's cost estimate (notional on a subscription). **Configure → Usage** (`anchi usage [--since 24h|7d|30d] [--by agent|model|runtime|day] [--json]`) shows the totals; on the screen **p** changes the period, **b** the grouping and **r** refreshes. Deleting a task keeps its usage rows.

**Subscription limits.** The same screen shows the limits of each runtime's subscription as the egress proxy last saw them: for Codex, the plan and its 5-hour and weekly windows ("40% used, resets 14:05") from the model stream; for Claude Code, its rate-limit headers. They are read on the trusted side, from the providers' responses, not from what the runtime in the cell reports. They appear after a turn of each runtime and are lost when the egress proxy restarts. Codex's are verified against live traffic; Claude Code's are not yet. A window past 80% shows yellow, past 95% red. After turns (at most once a minute) the daemon checks them and sends a desktop notification once when a window passes 80% and once past 95% in each window period, and once when a limit is reached. Scheduled and polling agents keep running; they use the same subscription.

## Limits

- At most `maxCells` cells work at once (default 4; `maxCells: 1` to `16` in `~/.anchi/settings.yaml`), counting cells that are still closing. A cell whose turn waits for a task it delegated is not working: it stays alive but frees its place, so a lead waiting for its reviewer never keeps the reviewer from starting. At most 16 cells are alive, waiting ones included. When no cell is free, the longest-idle one is closed to make room; otherwise the task waits (the task notes it): delegated tasks first, deepest first, then in the order they came, and only for as long as the tasks before it would take every free cell; after 10 minutes it fails with `TOO_MANY_CELLS`. A changed `maxCells` applies at once; a value outside 1 to 16 becomes the nearest one allowed, and the daemon log says so.
- Each working cell may use up to 2 GB of the VM's memory, and a cell waiting on a delegation keeps its runtime's memory (a few hundred MB). At the default `maxCells: 4` the 16 live cells are reached only by deep delegation — 4 working cells and 12 waiting on them — which is about 8 GB working plus a few GB waiting, more than a VM with half of a 16 GB computer has. Chains that deep are rare, but before raising `maxCells` or letting agents delegate several levels down, give the VM more memory: `limactl stop anchi-vm && limactl edit anchi-vm --memory 8 --cpus 6 && limactl start anchi-vm`, then `anchi setup vault unlock`.
- A turn that runs longer than 60 minutes is cancelled and the task fails.
- Finished tasks are deleted after 90 days; set `retentionDays` in `~/.anchi/settings.yaml` to change it.
- Polled items and delegated task text reach agents as task input. An agent with powerful connectors that is triggered by outside content (a Linear issue anyone can file) acts on that content. Listed high-risk operations wait by default whatever the origin, unless exempted with `highRisk.disable`; use `approvals` for its other writes, and `egress` to limit where it can send data.
- Credential isolation is not data isolation: agents can send what they read to any public host they may reach.
- Request bodies over 8 MiB stream through the proxy. S3 calls are re-signed on that path, including `aws-chunked` uploads with signed or unsigned chunks.
- A git push larger than git's `http.postBuffer` (1 MiB) is sent without a length and streams through the proxy at any size: the proxy reads its ref updates before any of it leaves. An ordinary push goes through. A high-risk push of this size (to `main` or `master`, deleting a branch) cannot wait for approval, since holding would stall the upload: it is refused, and git shows `! [remote rejected] main -> main (anchi: …)`; push to another branch and open a pull request. When the agent's GitHub writes ask (`approvals: {github: ask}`), pushes wait for you with their whole body as before, up to 8 MiB.
- Other large requests leave without credentials and fail upstream. The audit log records them as `pass:streamed`.
