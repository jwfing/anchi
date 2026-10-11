# Skills for using Anchi

`anchi/` is a skill that teaches an agent (Claude Code, Codex, Hermes or any agent that reads `SKILL.md`) to operate Anchi: setup, runtimes, accounts, agent files, tasks, delegation, triggers, approvals, audit and troubleshooting. It is for people and agents who *use* Anchi; the rules for contributing to this repository are in `AGENTS.md` and `.agents/skills/`.

Install it where your agent looks for skills:

```bash
# Claude Code (all projects)
mkdir -p ~/.claude/skills && cp -R skills/anchi ~/.claude/skills/
# Codex
mkdir -p ~/.codex/skills && cp -R skills/anchi ~/.codex/skills/
# An Anchi agent: pinned to the current commit, updatable with `anchi skills update anchi`
anchi skills add https://github.com/jwfing/anchi/tree/main/skills/anchi
```

`references/cli.md` is generated from the CLI's help: run `python3 scripts/gen-skill-cli.py` after changing a command. Keep the rest in step with the guides in `docs/` when behavior changes.
