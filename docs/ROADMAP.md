# Roadmap and project status

Anchi is a public development preview. This page describes priorities, not delivery dates or
support guarantees. Shipped changes are in [CHANGELOG.md](../CHANGELOG.md); implementation
status and remaining acceptance work are in the [architecture notes](architecture/AGENT_TEAM_PHASE3_PLAN.md#status).

| Area | Available now | Next work |
|---|---|---|
| Onboarding | Packaged macOS/Linux installation, TUI setup, manual agent files; starter creation without a model call | Fresh-machine acceptance for each runtime and platform, clearer recovery from setup failures |
| Security | Credential isolation, configured connectors/workspaces, approval rules, egress controls and offline regression tests | Complete live acceptance across connectors/runtimes and obtain independent security review |
| Distribution | Public archives, checksums, updater and changelog | Publisher signing, provenance and broader compatibility evidence |
| Developer experience | Task history, delegation, retries, audit, skills and TUI settings | File/diff review and richer artifact inspection; see the [backlog](architecture/BACKLOG.md) |
| Community | Issues, contributing guide, private vulnerability reporting | More reproducible bug reports, onboarding feedback and focused contributions |

A [remote server](REMOTE_SERVER.md) (an instabox VM or an SSH host) runs the daemon and cells; agents on different servers do not communicate. Windows and additional host architectures have no committed support plan.
A completed audit and signed packages are not current guarantees.

Use [feature requests](https://github.com/jwfing/anchi/issues/new/choose) to discuss a concrete
workflow before starting a large change. Use [private reporting](https://github.com/jwfing/anchi/security/advisories/new)
for vulnerabilities. Maintainer capacity may affect response times; there is no response SLA.
