# Agent team

Anchi runs a team of Codex agents. Each task runs in a disposable cell inside the `secure-vm` VM. GitHub, AWS and Linear credentials stay in the VM vault: an egress proxy adds them to the agent's requests on the way out. This guide covers installation, connecting accounts, creating agents and running tasks. The design is in [Agent team design](architecture/AGENT_TEAM_DESIGN.md), the interfaces are in [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md), and the boundaries are in [Security](../SECURITY.md#agent-team-task-cells-and-the-egress-proxy).

## Install

Prerequisites: Lima (`brew install lima`), Node 22+ and pnpm on the Mac.

```bash
pnpm --dir anchi install
scripts/anchi setup install        # VM, trusted services, agent team and base image (minutes)
scripts/anchi setup vault init     # first time only: creates ~/.config/secure-vm/vault.key
scripts/anchi setup vault unlock   # after each VM start
make verify-anchi                  # live isolation checks, no credentials used
```

`setup install` runs `scripts/up.sh`, `scripts/install-anchi.sh` and the base image build, and is safe to run again to update. `scripts/anchi setup vm` starts a stopped VM. In the TUI, **Runtimes** has the same steps: `I` install, `s` start the VM, `u` unlock the vault. Keep a backup of the vault key: without it, the stored credentials cannot be recovered.

`scripts/anchi` runs the CLI from the checkout. With no arguments it opens the TUI and starts the daemon if needed. `scripts/anchi daemon install` starts the daemon at login.

## Connect accounts

Codex uses your ChatGPT subscription. Log in on the Mac with `codex login`, then import the login:

```bash
scripts/anchi setup codex
```

This stores the access token and account id in the vault. The refresh token stays with the Codex CLI on the Mac. When the access token expires, run `codex` on the Mac once to refresh it, then import again.

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

Grant only what agents need:

- **GitHub:** a fine-grained token limited to the repositories the agents work on: contents, pull requests and issues read/write. For an organization's private repositories, choose the organization as the token's resource owner; the organization may also have to approve the token.
- **AWS:** a principal whose IAM policy allows only what the agents should do, for example `logs:FilterLogEvents` on specific log groups.

The proxy denies credential minting (GitHub keys and installation tokens, AWS STS/IAM key and session creation, Linear API keys), but any other permitted call acts with the full authority of the credential.

## Create agents

Open the TUI, select **Agent builder**, and describe the agent: its job, the services it needs and the tools it uses. The builder replies with a proposal. A full-screen dialog shows:

- the agent file;
- an image recipe, if the agent needs tools beyond the base image (git, gh, curl, jq and Codex on Debian 12).

Press `y` to write the files, or `n` to discard the proposal.

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

## Run tasks

In the TUI, select an agent and type a task. **Enter** sends it.

- Keyboard and mouse do the same things. **Tab** (or a click) moves between the sidebar and the main pane; the pane with the keys has a cyan border. In the sidebar, **↑ ↓** move, **1 2 3** jump to Configure, Agents and Tasks, **[ ]** turn task pages and **Enter** opens the item. In the main pane, **Esc** goes back to the sidebar (in a chat it first cancels a running turn and clears the draft). **?** lists every key.
- A task runs in a fresh cell. Follow-up messages reuse the cell until it has been idle for 10 minutes; after that, the next message resumes the Codex session in a new cell.
- **Ctrl+X** starts a new task. **Esc** cancels the running turn.
- **Ctrl+E** composes the message in `$EDITOR`, which helps if your terminal's IME misbehaves.
- The sidebar has three sections: **Configure** (runtimes, skills, connectors), **Agents** (the builder and your agents) and **Tasks** (every task, newest first, in pages). Select a task to see its status, times, links and transcript; **Enter** continues it in its agent's chat, **c** cancels it, **[** and **]** turn the page. Clicking works too.
- Consecutive tool calls fold into one line: while the turn runs it shows the count and the latest call; afterwards a click (or **Ctrl+T**) expands the list.

The CLI does the same:

```bash
scripts/anchi run dev "Fix https://github.com/me/repo/issues/12"
scripts/anchi send t-0123456789 "Also add a test"
scripts/anchi tasks
scripts/anchi scan t-0123456789     # credential-invariant scan of the live cell
```

Each agent has a persistent home in the VM, `/var/lib/anchi/agents/<id>/home`. It is mounted at `/home/agent` in the agent's cells and holds the work directory and Codex sessions. Everything else in a cell is discarded when the cell ends.

## Limits

- One turn at a time per agent and at most four live cells. The longest-idle cell is closed to make room.
- A turn that runs longer than 60 minutes is cancelled and the task fails.
- Credential isolation is not data isolation: agents can send what they read to any public host.
- S3 uploads signed as streaming payloads (`aws-chunked`, used by the AWS CLI for large objects) are refused.
- Phase 1 has no scheduled triggers and no agent-to-agent delegation.
