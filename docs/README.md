# Documentation

Start with the [project overview](../README.md) and [Getting started](GETTING_STARTED.md). Documentation is maintained in English. This index covers the current implementation, operating instructions and known limitations. Historical proposals and acceptance reports are not maintained; use Git history when needed.

## Using Anchi

| Document | Purpose |
|---|---|
| [Getting started](GETTING_STARTED.md) | Install on macOS or Linux and run the first Pi task |
| [Desktop app](DESKTOP_APP.md) | Workspace, sessions, approvals, activity, and connection management |
| [Connectors](CONNECTORS.md) | Gmail, Drive, Notion, and Slack operations, scopes, and authorization |
| [Gmail setup](GMAIL_SETUP.md) | Configure read-only Gmail OAuth |
| [Pi agent](PI_AGENT.md) | Install Pi and configure model authentication |
| [Pi chat protocol](PI_CHAT.md) | CLI and desktop RPC interface |
| [Agent team](AGENT_TEAM.md) | Install the agent team, connect GitHub/AWS/Linear, create agents and run tasks |

## Security and architecture

| Document | Purpose |
|---|---|
| [Security](../SECURITY.md) | Trust boundaries, current authorization modes, limitations, and reporting |
| [Security foundation](SECURITY_FOUNDATION.md) | Credential, policy, and inference services |
| [Repository architecture](architecture/REPOSITORY.md) | Module responsibilities and dependency direction |
| [Agent team design](architecture/AGENT_TEAM_DESIGN.md) | v2 design: daemon, per-task cells, credential-injecting proxy |
| [Agent team phase 1 plan](architecture/AGENT_TEAM_PHASE1_PLAN.md) | Milestones, decisions, acceptance and status for phase 1 |
| [Agent team phase 2 plan](architecture/AGENT_TEAM_PHASE2_PLAN.md) | Milestones, decisions, acceptance and status for phase 2 |
| [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md) | Agent configuration, client protocol, guest commands and cell runner protocol |

## Development and releases

| Document | Purpose |
|---|---|
| [Contributing](../CONTRIBUTING.md) | Development commands, checks, and documentation conventions |
| [Release process](engineering/RELEASE.md) | Packaging, signing, and release gates |
| [Changelog](../CHANGELOG.md) | Project changes |
| [License](../license.md) | Apache License 2.0 |
