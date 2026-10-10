# Documentation

Anchi is a secured agent team: Codex and Claude Code agents in disposable cells that never hold upstream credentials, each limited to what it is configured with. Start with the [project overview](../README.md), [Getting started](GETTING_STARTED.md) and the [agent team guide](AGENT_TEAM.md). Documentation is maintained in English. This index covers the current implementation, operating instructions and known limitations. Historical proposals and acceptance reports are not maintained; use Git history when needed.

## Using Anchi

| Document | Purpose |
|---|---|
| [Getting started](GETTING_STARTED.md) | Install on macOS or Linux, unlock the vault, connect a runtime, and get a shell in the VM |
| [Agent team](AGENT_TEAM.md) | Connect accounts; create, configure and delete agents; delegation, approvals, egress, triggers, skills, workspaces and tasks |
| [Key bindings](KEYBINDINGS.md) | TUI keys: the leader key, the command palette and `~/.anchi/keybindings.json` |
| [Connectors](CONNECTORS.md) | Gmail, Drive, Notion, and Slack operations, scopes, and authorization |
| [Gmail setup](GMAIL_SETUP.md) | Create the Google OAuth client for Gmail and Drive |

## Security and architecture

| Document | Purpose |
|---|---|
| [Security](../SECURITY.md) | Trust boundaries of the agent team, authorization modes, limitations, and reporting |
| [Security foundation](SECURITY_FOUNDATION.md) | Vault, credential and policy services |
| [Repository architecture](architecture/REPOSITORY.md) | Module responsibilities and dependency direction |
| [Agent team design](architecture/AGENT_TEAM_DESIGN.md) | Design of the secured agent team: daemon, per-task cells, credential-injecting proxy, connector bridge, known risks |
| [Agent team phase 1 plan](architecture/AGENT_TEAM_PHASE1_PLAN.md) | Phase 1 (done): daemon, cells, proxy, Codex, GitHub/AWS/Linear, builder; decisions and status |
| [Agent team phase 2 plan](architecture/AGENT_TEAM_PHASE2_PLAN.md) | Phase 2 (done): Claude Code, delegation, triggers, approvals, connector services; decisions and status |
| [Agent team phase 3 plan](architecture/AGENT_TEAM_PHASE3_PLAN.md) | Phase 3 (mostly done): containment, automatic checks, remaining acceptance; status |
| [Host directories](architecture/HOST_DIRECTORIES_PLAN.md) | Workspaces of the Mac in agent cells |
| [Backlog](architecture/BACKLOG.md) | Open requests and known gaps (file preview plugins, audit log view, token usage and quota, large git pushes), and what was delivered from it |
| [Agent team contracts](architecture/AGENT_TEAM_CONTRACTS.md) | Agent configuration, client protocol, guest commands and cell runner protocol |

## Development and releases

| Document | Purpose |
|---|---|
| [Contributing](../CONTRIBUTING.md) | Development commands, checks, and documentation conventions |
| [Release process](engineering/RELEASE.md) | Versioning and release gates |
| [Changelog](../CHANGELOG.md) | Project changes |
| [License](../license.md) | Apache License 2.0 |
