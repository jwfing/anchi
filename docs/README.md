# Documentation

Start with the [project overview](../README.md), [Getting started](GETTING_STARTED.md) and the [agent team guide](AGENT_TEAM.md). Documentation is maintained in English. This index covers the current implementation, operating instructions and known limitations. Historical proposals and acceptance reports are not maintained; use Git history when needed.

## Using Anchi

| Document | Purpose |
|---|---|
| [Getting started](GETTING_STARTED.md) | Install on macOS or Linux, unlock the vault and connect a runtime |
| [Agent team](AGENT_TEAM.md) | Connect accounts, create agents, delegation, approvals, triggers, skills and tasks |
| [Key bindings](KEYBINDINGS.md) | TUI keys: the leader key, the command palette and `~/.anchi/keybindings.json` |
| [Connectors](CONNECTORS.md) | Gmail, Drive, Notion, and Slack operations, scopes, and authorization |
| [Gmail setup](GMAIL_SETUP.md) | Create the Google OAuth client for Gmail and Drive |

## Security and architecture

| Document | Purpose |
|---|---|
| [Security](../SECURITY.md) | Trust boundaries, current authorization modes, limitations, and reporting |
| [Security foundation](SECURITY_FOUNDATION.md) | Vault, credential and policy services |
| [Repository architecture](architecture/REPOSITORY.md) | Module responsibilities and dependency direction |
| [Agent team design](architecture/AGENT_TEAM_DESIGN.md) | v2 design: daemon, per-task cells, credential-injecting proxy |
| [Agent team phase 1 plan](architecture/AGENT_TEAM_PHASE1_PLAN.md) | Milestones, decisions, acceptance and status for phase 1 |
| [Agent team phase 2 plan](architecture/AGENT_TEAM_PHASE2_PLAN.md) | Milestones, decisions, acceptance and status for phase 2 |
| [Agent team phase 3 plan](architecture/AGENT_TEAM_PHASE3_PLAN.md) | Proposal: containment, automatic checks and remaining acceptance |
| [Host directories](architecture/HOST_DIRECTORIES_PLAN.md) | Workspaces of the Mac in agent cells |
| [Backlog](architecture/BACKLOG.md) | Recorded requirements not yet planned: file preview plugins, deleting agents, new sessions, skills, builder, key bindings |
| [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md) | Agent configuration, client protocol, guest commands and cell runner protocol |

## Development and releases

| Document | Purpose |
|---|---|
| [Contributing](../CONTRIBUTING.md) | Development commands, checks, and documentation conventions |
| [Release process](engineering/RELEASE.md) | Versioning and release gates |
| [Changelog](../CHANGELOG.md) | Project changes |
| [License](../license.md) | Apache License 2.0 |
