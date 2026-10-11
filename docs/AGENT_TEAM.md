# Agent team

Anchi runs a secured team of Codex and Claude Code agents. Each task runs in a disposable cell inside the `secure-vm` VM, and each agent gets only the connectors, hosts, directories, skills and delegates in its configuration. Credentials stay in the VM vault: an egress proxy adds GitHub, AWS, Linear and model credentials to the agent's requests on the way out, and trusted services act for it on Gmail, Drive, Notion and Slack. This guide covers installation, connecting accounts, creating agents and running tasks. The design is in [Agent team design](architecture/AGENT_TEAM_DESIGN.md), the interfaces are in [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md), and the boundaries are in [Security](../SECURITY.md#agent-team-task-cells-and-the-egress-proxy).

## Install

Prerequisites: Lima (`brew install lima`), Node 22+ and pnpm on the Mac. On a Linux host (experimental), "the Mac" in this guide means that machine; its prerequisites and differences are in [Getting started](GETTING_STARTED.md#linux-prerequisites).

```bash
pnpm --dir anchi install
scripts/anchi setup install        # VM, trusted services, agent team and base image (minutes)
scripts/anchi setup vault init     # first time only: creates ~/.config/secure-vm/vault.key
scripts/anchi setup vault unlock   # after each VM start
make verify-anchi                  # live isolation checks, no credentials used
```

`setup install` runs `scripts/up.sh`, `scripts/install-anchi.sh` and the base image build, and is safe to run again to update. It refuses while task cells are live (a cell stays up 10 minutes after its task's last turn), since installing restarts the egress proxy; `make verify-anchi` refuses for the same reason. `scripts/anchi setup vm` starts a stopped VM. In the TUI, **Runtimes** has the same steps: `I` install, `s` start the VM, `u` unlock the vault. Keep a backup of the vault key: without it, the stored credentials cannot be recovered.

`scripts/anchi` runs the CLI from the checkout. With no arguments it opens the TUI and starts the daemon if needed. `scripts/anchi daemon install` starts the daemon at login.

## Connect accounts

Codex uses your ChatGPT subscription. Log in on the Mac with `codex login`, then import the login:

```bash
scripts/anchi setup codex
```

This stores the access token and account id in the vault. The refresh token stays with the Codex CLI on the Mac. Afterwards the daemon keeps the vault current: when the Codex CLI on the Mac has refreshed its login, the daemon imports the newer access token (checked on every change of `~/.codex/auth.json` and every five minutes). Set `codexAutoImport: false` in `~/.anchi/settings.yaml` to import only by hand. If the Mac has not used Codex for a while, run `codex` once to refresh its login.

Claude Code uses a long-lived subscription token, or an Anthropic API key:

```bash
claude setup-token          # on the Mac; prints a token
scripts/anchi setup claude  # paste it, without echo
```

Agents with `runtime: claude-code` then run Claude Code in their cells with a placeholder; the proxy substitutes the token on `api.anthropic.com`.

Connectors:

```bash
scripts/anchi setup connector github             # fine-grained token, prompted without echo
scripts/anchi setup connector github --from-gh   # or the token of the gh CLI (broader scopes)
scripts/anchi setup connector linear             # API key
scripts/anchi setup connector aws                # keys of a dedicated IAM principal and a region
scripts/anchi setup connector aws --profile dev  # or a profile on this Mac, such as AWS SSO
```

With `--profile`, the daemon exports the profile's temporary credentials with the AWS CLI on the Mac (`aws configure export-credentials`) and imports them again before they expire. The AWS CLI refreshes the SSO token while the SSO session lasts; when it ends, the daemon shows a notification and you run `aws sso login --profile dev`. In the TUI, **Connectors** offers `g` (GitHub from gh) and `p` (AWS profile).

Each command checks the credential with the service and prints the account it belongs to. A credential the service refuses is not kept. Run these commands in a terminal: they prompt for the secret without echo. They also read the secret from stdin when stdin is not a terminal. For AWS, stdin takes JSON: `{"accessKeyId", "secretAccessKey", "region", "sessionToken"?}`. In the TUI, the same setup is under **Connectors** and **Runtimes**.

Gmail, Drive, Notion and Slack are trusted services in the VM. Agents with these connectors call them through Anchi tools; the services' own policy decides each request.

```bash
scripts/anchi setup google-client ~/Downloads/client.json  # once, unless Anchi ships a built-in client
scripts/anchi setup service gmail      # Google sign-in in the browser (read-only scope)
scripts/anchi setup service gmail --account work   # a second Google account, named "work"
scripts/anchi setup service drive
scripts/anchi setup service notion     # internal integration secret, without echo
scripts/anchi setup service slack      # bot token
scripts/anchi setup service-mode notion ask   # every Notion write waits for your approval
```

Google tokens are obtained in the VM from the authorization code; they never reach the Mac. In the TUI, the **Services** part of **Connectors** does the same (`Enter` connect, `m` write mode, `d` disconnect).

Gmail and Drive can each hold several Google accounts, by name (`default` unless you pass `--account`). An agent uses `default` unless its file names another one, for connectors it has:

```yaml
connectors: [gmail, drive]
accounts: { gmail: work }       # Drive stays on `default`
```

The account is pinned to the agent's cells by the bridge in the VM; the agent cannot ask for another account, and approvals bind to the account they were given for. `scripts/anchi setup disconnect gmail --account work` disconnects one account.

Grant only what agents need:

- **GitHub:** a fine-grained token limited to the repositories the agents work on: contents, pull requests and issues read/write. For an organization's private repositories, choose the organization as the token's resource owner; the organization may also have to approve the token.
- **AWS:** a principal whose IAM policy allows only what the agents should do, for example `logs:FilterLogEvents` on specific log groups.

The proxy denies credential minting (GitHub keys and installation tokens, AWS STS/IAM key and session creation, Linear API keys), but any other permitted call acts with the full authority of the credential.

## Create agents

Open the TUI, select **Agent builder**, and describe the agent: its job, the services it needs and the tools it uses. Each turn, the builder is told what exists: installed skills, connectors and whether they are connected, directories under `~/AnchiWorkspaces`, agents and images. It replies with a proposal. A full-screen dialog shows:

- the agent file;
- an image recipe, if the agent needs tools beyond the base image (git, gh, curl, jq and Codex on Debian 12);
- what blocks it (a skill that is not installed, a directory that does not exist, an unknown delegate) and what is worth knowing (a connector not connected yet).

Press `y` to write the files, `n` to discard the proposal, or `s` to change its settings yourself in the settings panel; the proposal is checked again and shown with your changes.

The builder can also change an existing agent. Each turn it gets a one-line summary of every agent, and the agent file of each agent your message names by id (`dev` or `@dev`; up to 4 KB per file). For a change it proposes a patch with only the fields to change: name, description, runtime, model, effort, prompt, skills, connectors and workspaces. The dialog shows the change as a diff of the agent file, and the rest of the file, comments included, stays as it is. If the file changes before you press `y`, the patch is refused; ask the builder again. For other fields (triggers, approvals, egress, delegates, image), the builder proposes the whole file, which replaces the old one. The builder cannot write any file itself.

Agents are YAML files in `~/.anchi/agents/`, and recipes are in `~/.anchi/images/`. You can also edit them directly; the daemon reloads them on change. See [Agent configuration](architecture/AGENT_TEAM_CONTRACTS.md#agent-configuration).

```yaml
# ~/.anchi/agents/dev.yaml
name: Developer
runtime: codex
connectors: [github]
image: node
prompt:
  text: Fix the GitHub issue you are given, push a branch and open a pull request.
```

## Agent settings

**^X s** in an agent's chat (or **s** on it in the sidebar) opens its settings panel. It lists the agent's name, description, runtime (marked connected or not), model, effort and prompt, then every installed skill, every connector (marked connected or not) and every directory under `~/AnchiWorkspaces`. **Space** changes the selected row:

- on name, description or model, you type the new value (an empty model means the runtime's default);
- runtime switches between `codex` and `claude-code`, and effort goes through unset, `low`, `medium`, `high` and `xhigh` (only Codex uses it);
- the prompt mode switches between `append` and `replace`, and the prompt text opens in `$EDITOR`;
- skills and connectors are selected or deselected, and a workspace goes off → `ro` → `rw`.

At the bottom, the panel shows what it cannot change: template, image, sandbox, delegates, approvals, egress and triggers. Edit those in the agent file. For an agent that `extends` a template, an inherited value is marked `from template <id>`. Changing an inherited value writes an override into the agent's own file. A prompt that comes from `prompt.file` is read-only in the panel; edit that file instead.

**Enter** shows the change to the agent file as a diff, checked like a proposal. Errors block saving, for example `sandbox: codex-workspace-write` with runtime `claude-code`. Warnings, such as a runtime that is not connected yet, do not block. **y** saves the change. Only the fields you changed are written; an emptied model, effort or description removes its key. The rest of the file, comments included, stays as it is. The change applies to the agent's next cell.

## Delete an agent

**D** on the agent in the sidebar, **D** in its settings panel, **^X D** in its chat, or `scripts/anchi agents rm <id>`. A dialog lists what goes and what stays; type the agent's id to confirm. Deleting:

- removes the agent file;
- deletes all its tasks and transcripts, with the tasks they delegated to other agents; running and queued ones are cancelled first. A task of another agent that had delegated to it stays, with a note;
- forgets its triggers and what its polls have seen;
- removes it from other agents' `delegates`, keeping the rest of their files;
- in the VM, removes its home (work directory, Codex and Claude sessions), its skills and its policy rules.

Directories of your computer in `~/AnchiWorkspaces` are not touched: they are only bound inside the agent's cells, and the VM refuses the removal while the agent has a cell or anything under its home is a mount point. Audit logs are kept. If the VM is not running, the rest is done and the dialog says so; deleting the agent again later finishes the VM part. The builder cannot be deleted.

## Teams, approvals, triggers and skills

```yaml
# ~/.anchi/agents/lead.yaml
name: Lead
runtime: claude-code
connectors: [linear, github]
delegates: [developer]          # may hand tasks to these agents
approvals: { github: ask }      # its GitHub writes (push, PR, comments) wait for you
highRisk: { disable: [github-merge] }  # it merges pull requests without asking
skills: [triage]
triggers:
  - poll: { type: linear-issues, label: agent }
    text: "Triage {title} ({url}) and delegate the fix"
  - schedule: '0 9 * * 1-5'
    text: Summarize yesterday's merged pull requests
```

- **Delegation.** An agent with `delegates` gets the tools `anchi_delegate_task`, `anchi_task_status`, `anchi_send_to_task` and `anchi_list_tasks`. A delegated task runs in its own cell with its own connectors; the parent waits for its result. Delegation stops at three levels, ten children per task and sixty turns per tree, and an agent cannot be asked to work on a task above its own.
- **Approvals.** Without `approvals`, an agent's writes go straight through; only high-risk operations (below) wait for you. With `approvals: {<connector>: ask}` for github, aws or linear, the proxy holds the agent's writes: git push, GitHub API writes and mutations, AWS operations other than reads, Linear mutations. A full-screen dialog shows the git refs or the start of the request; `y` lets it through, `n` refuses it, and it is refused after five minutes. For Gmail, Drive, Notion and Slack, `ask` holds the agent's writes in the service's own policy (`notion:writer`), alongside each service's write mode, which applies to every agent; reads follow the service's mode. `scripts/anchi approvals`, `approve ID` and `deny ID` do the same from the CLI.
- **High-risk operations always ask**, for every agent and every task origin, whatever its `approvals`: merging a pull request, deleting, transferring or reconfiguring a repository, branch protection, collaborators, webhooks and deploy keys, deleting a branch, pushing to `main` or `master`, AWS deletions, terminations and access changes, and Linear deletions. The dialog says why the write is held and how the task started (`poll → @lead (t-…) → @developer (t-…)`). Switch entries off for every agent in `~/.anchi/settings.yaml` (`highRisk: { disable: [github-merge] }`), or for one agent in its file with the same field: a merge agent with `highRisk: { disable: [github-merge] }` merges without asking while other agents still ask. The ids: `github-merge`, `github-repo-delete`, `github-repo-settings`, `github-repo-transfer`, `github-protection`, `github-access`, `github-ref-delete`, `github-graphql`, `git-default-branch`, `git-ref-delete`, `aws-destroy`, `aws-s3-delete`, `aws-s3-access` and `linear-delete` (`services/egress_rules.py`); an unknown id is an error in the agent file. A task's access report shows the agent's exceptions. The proxy cannot tell a force-push from a fast-forward, so it holds pushes to the default branch names rather than force-pushes.
- **Egress.** `egress: [registry.npmjs.org, '*.pypi.org']` limits the hosts an agent's cells reach; its runtime and connectors' hosts are always allowed (for Codex: `chatgpt.com`, `*.chatgpt.com` and OpenAI's content CDN `*.oaiusercontent.com`). Other connections fail and are audited as `egress-denied`, and the task notes each refused host once while it runs. To allow one, press **a** on the task, then **e**, choose the host and confirm (or `scripts/anchi agents allow-host <agent> <host>`): the exact host is added to the agent's `egress`, from its next cell on. Wildcards are added by editing the file. Without `egress` the agent reaches any public host. An allowed host can still receive data (a gist on `github.com`), so a list narrows exfiltration; it does not end it.
- **Triggers.** `schedule` takes a cron expression in local time; a run missed while the Mac slept runs once on wake. `poll` checks Linear issues (by `team`, `label` or `state`) or a GitHub issue search (`query`) every `every` minutes (default 5) and starts one task per new item; items that existed when the trigger was added are skipped. `scripts/anchi triggers` lists them.
- **Skills.** `scripts/anchi skills add <directory or GitHub URL> [--id x]`, or **a** on the **Skills** screen, stores a `SKILL.md` skill; a GitHub skill is pinned to the commit it was fetched at. Give it to agents in their settings panel (**^X s**) or with `skills: [id]`; their cells get it read-only. `scripts/anchi skills update [id]`, or **u** on the Skills screen, shows what the latest commit of the URL changes (files added, changed, removed) and installs exactly that commit after you confirm. Skill content is untrusted, like any other agent input.

## Directories of your computer (workspaces)

Share `~/AnchiWorkspaces` with the VM once (it restarts the VM and unlocks the vault again; on Linux it also reinstalls the guest components, see [Linux differences](GETTING_STARTED.md#linux-differences)):

```bash
scripts/anchi setup workspaces      # or W on the Runtimes screen
```

Then give an agent directories under it:

```yaml
workspaces:
  - path: projects/webapp   # ~/AnchiWorkspaces/projects/webapp
    mode: rw                # ro by default
```

They appear in the agent's cells at `/home/agent/workspaces/<name>`; a cell sees no other directory of your computer. Writes to an `rw` workspace go straight to your computer and are owned by you.

A writable directory lets an agent leave code that your own tools later run. Anchi mounts git hooks, git configuration and info, `.gitattributes`, `.envrc`, `.vscode/` and `.idea/` read-only in the repositories near the top of an `rw` workspace. After each turn it compares the workspace with its state before the turn and notes in the task transcript any new git hook, git configuration that runs commands, symlink pointing outside the workspace, new executable file or changed editor or shell configuration. It never changes your files. Files that tools run by design, such as `package.json` scripts or a `Makefile`, cannot be masked: review an agent's changes before you run them.

## Run tasks

In the TUI, select an agent and type a task. **Enter** sends it.

- Keyboard and mouse do the same things. **Tab** (or a click) moves between the sidebar and the main pane; the pane with the keys has a cyan border. In the sidebar, **↑ ↓** move, **1 2 3** jump to Configure, Agents and Tasks, **[ ]** turn task pages and **Enter** opens the item. In the main pane, **Esc** goes back to the sidebar (in a chat it first cancels a running turn and clears the draft).
- Every action is also reachable through the leader key **Ctrl+X** and one more key; a panel shows what can follow. **^X Space** opens the command palette and **^X ?** lists the keys of the current view; both stay at the right of the status line. To copy text, **^X m** turns on selection mode: the mouse goes back to the terminal, which selects and copies the transcript without borders or the sidebar. Keys can be changed in `~/.anchi/keybindings.json`: see [Key bindings](KEYBINDINGS.md).
- A task runs in a fresh cell. Follow-up messages reuse the cell until it has been idle for 10 minutes; after that, the next message resumes the agent's Codex or Claude Code session in a new cell.
- Before a cell is destroyed (idle timeout, cancellation, daemon shutdown), it is scanned for real credential values; the task notes `scan: clean`, and a finding raises a notification.
- A failed or cancelled task can run again: **R** on the task (or **^X r** in its chat, or `scripts/anchi retry <task>`) either continues its session, telling the agent why the last turn stopped so it keeps the work it had done, or starts over as a new task with the same request (`--fresh`).
- **^X n** starts a new task, which is also a new Codex or Claude session; **Enter** otherwise sends a follow-up to the task shown. **Esc** cancels the running turn.
- The input edits like a shell line (**Ctrl+A**, **Ctrl+E**, **Ctrl+W**, **Ctrl+U**, arrows). **Ctrl+G** (or **^X e**) composes the message in `$EDITOR`, which helps if your terminal's IME misbehaves.
- The sidebar has three sections: **Configure** (runtimes, skills, connectors), **Agents** (the builder and your agents) and **Tasks** (every task, newest first, in pages). Select a task to see its status, times, links and transcript; **Enter** continues it in its agent's chat, **R** runs a failed one again, **c** cancels it, **D** deletes it, **[** and **]** turn the page. Clicking works too.
- **a** on a task (or **^X l**) shows its external access: see [Access and usage](#access-and-usage).
- Consecutive tool calls fold into one line: while the turn runs it shows the count and the latest call; afterwards a click (or **^X t**) expands the list.

The CLI does the same:

```bash
scripts/anchi run dev "Fix https://github.com/me/repo/issues/12"
scripts/anchi send t-0123456789 "Also add a test"
scripts/anchi tasks --status failed --since 7d --search login
scripts/anchi rm t-0123456789       # delete a finished task and the tasks it delegated
scripts/anchi scan t-0123456789     # credential-invariant scan of the live cell
scripts/anchi audit t-0123456789    # what the task reached outside, and with which credentials
scripts/anchi usage --since 7d --by model
```

Each agent has a persistent home in the VM, `/var/lib/anchi/agents/<id>/home`. It is mounted at `/home/agent` in the agent's cells and holds the work directory and Codex sessions. Everything else in a cell is discarded when the cell ends.

## Access and usage

**A task's access.** The egress proxy writes a row for every request a cell makes, every cell registration and every bridge call. **a** on a task (**^X l**, `scripts/anchi audit <task> [--json]`) reads the task's rows from the VM and shows:

- A headline that checks the boundary, for example "42 requests; 17 with credentials injected by the proxy; the cell sent only placeholders or no credential; 2 refused or held; scan: clean". It turns red when a cell sent a credential of its own (something other than a placeholder) to a host.
- The scope of the cell: connectors, bridge services, egress list and the writes it holds.
- The hosts requested, with a count of each decision (`inject`, `pass`, `deny`, `egress-denied`, …).
- The requests refused or held, with the outcome of each approval.
- Gmail, Drive, Notion and Slack calls through the bridge.
- The latest requests (method, host, path, decision). Query strings and header values are never recorded.

Hosts and paths come from the agent's requests, so they are shown as agent text. The VM keeps the log up to 50 MB and one rotated file. The daemon saves a task's rows when each of its cells closes and whenever they are read (up to 5,000 per task), so a task's record outlives the rotation and goes when the task is deleted. If the VM cannot be read, the view shows the saved rows and says so.

**Every agent's access.** **Configure → Access** (`scripts/anchi access [--since 24h|7d|30d] [--json]`) sums up the saved rows of all tasks over a period: per agent its tasks, requests, hosts, refusals, held writes and the credentials the proxy injected by connector; the hosts most requested and by whom; every request where a cell sent a credential of its own; and the latest refusals. **p** changes the period and **r** refreshes. Rows of running tasks are read from the VM when the screen opens.

**A credential of the cell's own.** Anchi's credentials never enter a cell; the cell sends placeholders, and the proxy replaces them. When a cell sends something else in `Authorization` or `x-api-key` (a key from the task text or a file, for example), the proxy tells the daemon at once: the task gets a ⚠ note naming the host, and a desktop notification goes out, once per host and cell. Every such request is in the access view, and its headline turns red.

**Token usage.** Every turn's tokens are recorded with the agent, runtime and model: input, cached input, output and reasoning tokens, and Claude Code's cost estimate (notional on a subscription). **Configure → Usage** (`scripts/anchi usage [--since 24h|7d|30d] [--by agent|model|runtime|day] [--json]`) shows the totals; on the screen **p** changes the period, **b** the grouping and **r** refreshes. Deleting a task keeps its usage rows.

**Subscription limits.** The same screen shows the limits of each runtime's subscription as the egress proxy last saw them: for Codex, the plan and its 5-hour and weekly windows ("40% used, resets 14:05") from the model stream; for Claude Code, its rate-limit headers. They are read on the trusted side, from the providers' responses, not from what the runtime in the cell reports. They appear after a turn of each runtime and are lost when the egress proxy restarts. Codex's are verified against live traffic; Claude Code's are not yet. A window past 80% shows yellow, past 95% red. After turns (at most once a minute) the daemon checks them and sends a desktop notification once when a window passes 80% and once past 95% in each window period, and once when a limit is reached. Scheduled and polling agents keep running; they use the same subscription.

## Limits

- One turn at a time per agent and at most four live cells, counting cells that are still closing. The longest-idle cell is closed to make room; when all four are busy, a new task waits for one (the task notes it) and fails after 10 minutes.
- A turn that runs longer than 60 minutes is cancelled and the task fails.
- Finished tasks are deleted after 90 days; set `retentionDays` in `~/.anchi/settings.yaml` to change it.
- Polled items and delegated task text reach agents as task input. An agent with powerful connectors that is triggered by outside content (a Linear issue anyone can file) acts on that content. High-risk operations wait for you whatever the origin; use `approvals` for its other writes, and `egress` to limit where it can send data.
- Credential isolation is not data isolation: agents can send what they read to any public host they may reach.
- Request bodies over 8 MiB stream through the proxy. S3 calls are re-signed on that path, including `aws-chunked` uploads with signed or unsigned chunks.
- A git push larger than git's `http.postBuffer` (1 MiB) is sent without a length and streams through the proxy at any size: the proxy reads its ref updates before any of it leaves. An ordinary push goes through. A high-risk push of this size (to `main` or `master`, deleting a branch) cannot wait for approval, since holding would stall the upload: it is refused, and git shows `! [remote rejected] main -> main (anchi: …)`; push to another branch and open a pull request. When the agent's GitHub writes ask (`approvals: {github: ask}`), pushes wait for you with their whole body as before, up to 8 MiB.
- Other large requests leave without credentials and fail upstream. The audit log records them as `pass:streamed`.
