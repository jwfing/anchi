# `anchi` command reference

Generated from `anchi --help` by `scripts/gen-skill-cli.py`; run `anchi <command> --help` for the installed version. From a source checkout, use `scripts/anchi`.

## `anchi`

```text
Usage: anchi [options] [command]

Anchi (安栖): a secured agent team

Options:
  -V, --version                    output the version number
  --server <target>                the server to use: local, instabox:<machine>
                                   or ssh:<[user@]host> (default: ANCHI_SERVER,
                                   else the saved one, else local)

Commands:
  server [target]                  Show the server this computer uses, or save
                                   one: local, instabox:<machine> or
                                   ssh:<[user@]host>
  update [options]                 Update this installation to the latest
                                   release
  tui                              Open the full-screen client (starts the
                                   daemon if needed)
  keys                             Key bindings of the TUI: the defaults merged
                                   with ~/.anchi/keybindings.json
  run [options] <agent> <text...>  Give an agent a task and stream it until the
                                   turn ends
  send [options] <task> <text...>  Send a follow-up to a task
  retry [options] <task>           Run a failed or cancelled task again:
                                   continue its session, or start over
  audit [options] <task>           A task's external access: hosts requested,
                                   credentials injected, refusals (egress audit
                                   log)
  access [options]                 External access of every agent over a period:
                                   hosts, injections, refusals
  usage [options]                  Token use by agent, model, runtime or day,
                                   and the subscription limits last seen
  tasks [options]                  List tasks, newest first
  rm <task>                        Delete a finished task, the tasks it
                                   delegated and their transcripts
  scan <task>                      Credential-invariant scan of a task's live
                                   cell
  skills                           Skills agents can use
  triggers                         Agents' schedules and polls, with their next
                                   run and last result
  approvals [options]              Writes waiting for your approval
  approve <id>                     Approve a write waiting for approval
  deny <id>                        Deny a write waiting for approval
  cancel <task>                    Cancel a running or queued task; its work and
                                   transcript are kept
  agents [options]                 List or manage agents
  setup                            Runtime and connector setup
  daemon                           Manage the background daemon
```

### `anchi server`

```text
Usage: anchi server [options] [target]

Show the server this computer uses, or save one: local, instabox:<machine> or
ssh:<[user@]host>
```

### `anchi update`

```text
Usage: anchi update [options]

Update this installation to the latest release

Options:
  --check     Check for a newer version without installing
```

### `anchi tui`

```text
Usage: anchi tui [options]

Open the full-screen client (starts the daemon if needed)
```

### `anchi keys`

```text
Usage: anchi keys [options] [command]

Key bindings of the TUI: the defaults merged with
~/.anchi/keybindings.json

Commands:
  init        Write a starting keybindings.json (the leader and an example)
```

#### `anchi keys init`

```text
Usage: anchi keys init [options]

Write a starting keybindings.json (the leader and an example)
```

### `anchi run`

```text
Usage: anchi run [options] <agent> <text...>

Give an agent a task and stream it until the turn ends

Options:
  -v, --verbose  show tool output
```

### `anchi send`

```text
Usage: anchi send [options] <task> <text...>

Send a follow-up to a task

Options:
  -v, --verbose  show tool output
```

### `anchi retry`

```text
Usage: anchi retry [options] <task>

Run a failed or cancelled task again: continue its session, or start over

Options:
  --fresh        start over: a new task with the same request
  -v, --verbose  show tool output
```

### `anchi audit`

```text
Usage: anchi audit [options] <task>

A task's external access: hosts requested, credentials injected, refusals
(egress audit log)

Options:
  --json      the full report as JSON
```

### `anchi access`

```text
Usage: anchi access [options]

External access of every agent over a period: hosts, injections, refusals

Options:
  --since <age>  period, e.g. 24h or 7d (default: "7d")
  --json         the summary as JSON
```

### `anchi usage`

```text
Usage: anchi usage [options]

Token use by agent, model, runtime or day, and the subscription limits last seen

Options:
  --since <age>  period, e.g. 24h or 7d (default: "7d")
  --by <group>   agent, model, runtime or day (default: "agent")
  --json         totals and limits as JSON
```

### `anchi tasks`

```text
Usage: anchi tasks [options]

List tasks, newest first

Options:
  -a, --agent <id>
  -s, --status <status>  queued, running, done, failed or cancelled
  -q, --search <words>   words in the title or result
  --since <age>          created within, e.g. 24h or 7d
  -n, --limit <n>        how many (default: "50")
  --json                 Print the task array as JSON
```

### `anchi rm`

```text
Usage: anchi rm [options] <task>

Delete a finished task, the tasks it delegated and their transcripts
```

### `anchi scan`

```text
Usage: anchi scan [options] <task>

Credential-invariant scan of a task's live cell
```

### `anchi skills`

```text
Usage: anchi skills [options] [command]

Skills agents can use

Commands:
  add [options] <source>  From a local directory with SKILL.md, or a GitHub URL
                          (pinned to its commit); a directory or repository of
                          skills adds each one
  update [options] [id]   Update GitHub skills to the latest commit of their
                          URL, after showing what changes
  rm <id>                 Remove a skill; agents that list it fail to start
                          until it is removed from them
```

#### `anchi skills add`

```text
Usage: anchi skills add [options] <source>

From a local directory with SKILL.md, or a GitHub URL (pinned to its commit); a
directory or repository of skills adds each one

Options:
  --id <id>   the id of a single skill
```

#### `anchi skills update`

```text
Usage: anchi skills update [options] [id]

Update GitHub skills to the latest commit of their URL, after showing what
changes

Options:
  -y, --yes   update without asking
```

#### `anchi skills rm`

```text
Usage: anchi skills rm [options] <id>

Remove a skill; agents that list it fail to start until it is removed from them
```

### `anchi triggers`

```text
Usage: anchi triggers [options]

Agents' schedules and polls, with their next run and last result
```

### `anchi approvals`

```text
Usage: anchi approvals [options]

Writes waiting for your approval

Options:
  --json      Print the pending approval array as JSON
```

### `anchi approve`

```text
Usage: anchi approve [options] <id>

Approve a write waiting for approval
```

### `anchi deny`

```text
Usage: anchi deny [options] <id>

Deny a write waiting for approval
```

### `anchi cancel`

```text
Usage: anchi cancel [options] <task>

Cancel a running or queued task; its work and transcript are kept
```

### `anchi agents`

```text
Usage: anchi agents [options] [command]

List or manage agents

Options:
  --json                  Print the agent array as JSON

Commands:
  create [options] <id>   Review and create a starter agent without a model call
  rm [options] <id>       Delete an agent with its tasks and its files in the VM
                          (workspaces are kept)
  allow-host <id> <host>  Add one host to an agent's egress list (a host its
                          cells were refused)
```

#### `anchi agents create`

```text
Usage: anchi agents create [options] <id>

Review and create a starter agent without a model call

Options:
  --runtime <runtime>  codex, claude-code or hermes
  --preview            Print the proposal without saving it
  -y, --yes            Save the reviewed starter without an interactive prompt
```

#### `anchi agents rm`

```text
Usage: anchi agents rm [options] <id>

Delete an agent with its tasks and its files in the VM (workspaces are kept)

Options:
  -y, --yes   delete without typing the id
```

#### `anchi agents allow-host`

```text
Usage: anchi agents allow-host [options] <id> <host>

Add one host to an agent's egress list (a host its cells were refused)
```

### `anchi setup`

```text
Usage: anchi setup [options] [command]

Runtime and connector setup

Commands:
  prepare [options]                               Prepare the environment, credential storage and one runtime; resume completed steps
  status [options]                                VM, vault, runtimes, connectors and services at a glance
  codex [options]                                 Import the Codex login from ~/.codex/auth.json into the VM vault
  claude                                          Store a `claude setup-token` token or an Anthropic API key in the VM vault
  hermes [options]                                Store Hermes's OpenAI-compatible endpoint, API key and default model in the VM vault
  workspaces [options]                            Share ~/AnchiWorkspaces with the VM (macOS and Linux; restarts the VM once)
  vm                                              Start the VM
  install [options]                               Create or update the VM, install the services and build the base image
  vault <action>                                  init or unlock the VM vault with the key in ~/.config/anchi/vault.key
  connector [options] <id>                        Connect github, aws, linear, posthog, sentry, firecrawl, figma or discord (secrets are read without echo)
  disconnect [options] <id>                       Remove a connector or service credential from the vault (Google accounts are revoked too)
  service [options] <id>                          Connect gmail, drive, x or reddit (browser sign-in), or notion or slack (token, without echo)
  reddit-client <client-id> <developer-username>  Store an approved Reddit installed app client; callback http://127.0.0.1:48174/callback
  x-client <client-id>                            Store an X native app Client ID; register http://127.0.0.1:48173/callback in X
  google-client [options] [path]                  Store your own Google Cloud Desktop app OAuth client JSON (Gmail and Drive); it overrides the built-in client
  reset [options]                                 Back to a first launch: delete the VM with everything in it (--all: also the vault key and the Anchi home)
  service-mode <id> <mode>                        Writes of a service: auto, or ask (X always requires approval)
```

#### `anchi setup prepare`

```text
Usage: anchi setup prepare [options]

Prepare the environment, credential storage and one runtime; resume completed
steps

Options:
  --runtime <runtime>  codex, claude-code or hermes (default: detected login)
  -y, --yes            confirm preparation using recommended resources
  --cpus <n>           CPUs for a new VM (advanced)
  --memory <gib>       memory for a new VM in GiB (advanced)
```

#### `anchi setup status`

```text
Usage: anchi setup status [options]

VM, vault, runtimes, connectors and services at a glance

Options:
  --json      the full status as JSON
```

#### `anchi setup codex`

```text
Usage: anchi setup codex [options]

Import the Codex login from ~/.codex/auth.json into the VM vault

Options:
  -y, --yes   do not ask for confirmation
```

#### `anchi setup claude`

```text
Usage: anchi setup claude [options]

Store a `claude setup-token` token or an Anthropic API key in the VM vault
```

#### `anchi setup hermes`

```text
Usage: anchi setup hermes [options]

Store Hermes's OpenAI-compatible endpoint, API key and default model in the VM
vault

Options:
  --base-url <url>  e.g. https://openrouter.ai/api/v1
  --model <model>   the default model, e.g. nousresearch/hermes-4-405b
```

#### `anchi setup workspaces`

```text
Usage: anchi setup workspaces [options]

Share ~/AnchiWorkspaces with the VM (macOS and Linux; restarts the VM once)

Options:
  -y, --yes   do not ask for confirmation
```

#### `anchi setup vm`

```text
Usage: anchi setup vm [options]

Start the VM
```

#### `anchi setup install`

```text
Usage: anchi setup install [options]

Create or update the VM, install the services and build the base image

Options:
  -y, --yes       do not ask for confirmation
  --cpus <n>      CPUs of a new VM (default: half of this computer's)
  --memory <gib>  memory of a new VM in GiB (default: half of this computer's)
```

#### `anchi setup vault`

```text
Usage: anchi setup vault [options] <action>

init or unlock the VM vault with the key in ~/.config/anchi/vault.key
```

#### `anchi setup connector`

```text
Usage: anchi setup connector [options] <id>

Connect github, aws, linear, posthog, sentry, firecrawl, figma or discord
(secrets are read without echo)

Options:
  --from-gh         github: import the token the gh CLI is logged in with
  --profile <name>  aws: use a host profile (SSO); the daemon keeps it refreshed
  -y, --yes         do not ask for confirmation
```

#### `anchi setup disconnect`

```text
Usage: anchi setup disconnect [options] <id>

Remove a connector or service credential from the vault (Google accounts are
revoked too)

Options:
  --account <name>  gmail or drive: the account to disconnect (default: default)
```

#### `anchi setup service`

```text
Usage: anchi setup service [options] <id>

Connect gmail, drive, x or reddit (browser sign-in), or notion or slack (token,
without echo)

Options:
  --account <name>  gmail or drive: name this Google account (e.g. work) to
                    connect more than one; agents pick it with accounts: {
                    gmail: work }
```

#### `anchi setup reddit-client`

```text
Usage: anchi setup reddit-client [options] <client-id> <developer-username>

Store an approved Reddit installed app client; callback
http://127.0.0.1:48174/callback
```

#### `anchi setup x-client`

```text
Usage: anchi setup x-client [options] <client-id>

Store an X native app Client ID; register http://127.0.0.1:48173/callback in X
```

#### `anchi setup google-client`

```text
Usage: anchi setup google-client [options] [path]

Store your own Google Cloud Desktop app OAuth client JSON (Gmail and Drive); it
overrides the built-in client

Options:
  --remove    remove your client and use the built-in one, when Anchi ships one
```

#### `anchi setup reset`

```text
Usage: anchi setup reset [options]

Back to a first launch: delete the VM with everything in it (--all: also the
vault key and the Anchi home)

Options:
  --all       also delete the vault key and ~/.anchi (agents, tasks, settings,
              logs)
  -y, --yes   do not ask for confirmation
```

#### `anchi setup service-mode`

```text
Usage: anchi setup service-mode [options] <id> <mode>

Writes of a service: auto, or ask (X always requires approval)
```

### `anchi daemon`

```text
Usage: anchi daemon [options] [command]

Manage the background daemon

Commands:
  start           Start the daemon in the background if it is not running
  stop            Stop the daemon; its cells are scanned and closed, running
                  turns end
  status          Whether the daemon runs, with its pid, home, start time,
                  clients and cells, as JSON
  install         Run the daemon at login (launchd on macOS, a systemd user unit
                  on Linux)
  uninstall       Stop running the daemon at login
```

#### `anchi daemon start`

```text
Usage: anchi daemon start [options]

Start the daemon in the background if it is not running
```

#### `anchi daemon stop`

```text
Usage: anchi daemon stop [options]

Stop the daemon; its cells are scanned and closed, running turns end
```

#### `anchi daemon status`

```text
Usage: anchi daemon status [options]

Whether the daemon runs, with its pid, home, start time, clients and cells, as
JSON
```

#### `anchi daemon install`

```text
Usage: anchi daemon install [options]

Run the daemon at login (launchd on macOS, a systemd user unit on Linux)
```

#### `anchi daemon uninstall`

```text
Usage: anchi daemon uninstall [options]

Stop running the daemon at login
```
