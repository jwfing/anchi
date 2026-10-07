# Agent team

Anchi runs a team of Codex agents. Each task runs in a disposable cell inside the `secure-vm` VM. GitHub, AWS and Linear credentials stay in the VM vault: an egress proxy adds them to the agent's requests on the way out. This guide covers installation, connecting accounts, creating agents and running tasks. The design is in [Agent team design](architecture/AGENT_TEAM_DESIGN.md), the interfaces are in [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md), and the boundaries are in [Security](../SECURITY.md#agent-team-task-cells-and-the-egress-proxy).

## Install

Prerequisites:

- the VM and trusted services from [Getting started](GETTING_STARTED.md): `scripts/up.sh` and `scripts/install-pi.sh`;
- an unlocked vault: `python3 scripts/vault.py unlock`;
- Node 22+ and pnpm on the Mac.

```bash
pnpm --dir anchi install
bash scripts/install-anchi.sh                         # egress proxy, cell manager, cell runner
limactl shell secure-vm -- sudo anchi-image build codex base   # base image, about 4 minutes
make verify-anchi                                     # live isolation checks, no credentials used
```

`scripts/anchi` runs the CLI from the checkout. With no arguments it opens the TUI and starts the daemon if needed. `scripts/anchi daemon install` starts the daemon at login.

## Connect accounts

Codex uses your ChatGPT subscription. Log in on the Mac with `codex login`, then import the login:

```bash
scripts/anchi setup codex
```

This stores the access token and account id in the vault. The refresh token stays with the Codex CLI on the Mac. When the access token expires, run `codex` on the Mac once to refresh it, then import again.

Connectors:

```bash
scripts/anchi setup connector github     # fine-grained token, prompted without echo
scripts/anchi setup connector linear     # API key
scripts/anchi setup connector aws        # keys of a dedicated IAM principal and a region
```

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

- A task runs in a fresh cell. Follow-up messages reuse the cell until it has been idle for 10 minutes; after that, the next message resumes the Codex session in a new cell.
- **Ctrl+X** starts a new task. **Esc** cancels the running turn.
- **Ctrl+E** composes the message in `$EDITOR`, which helps if your terminal's IME misbehaves.
- **Tasks** lists every task with its status, result and links.

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
- Credential isolation is not data isolation: agents can send what they read to any public host.
- S3 uploads signed as streaming payloads (`aws-chunked`, used by the AWS CLI for large objects) are refused.
- Phase 1 has no scheduled triggers and no agent-to-agent delegation.
