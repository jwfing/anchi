# Skills for using Anchi

`anchi/` teaches a **host-side** coding agent to operate Anchi: setup, agent files, tasks,
approvals, audit and troubleshooting. Contribution procedures live separately in
[`AGENTS.md`](../AGENTS.md) and [`.agents/skills/`](../.agents/skills).

## Install for a host-side agent

The release archive ships the skill next to the app, matched to the installed version by
construction: `~/.local/share/anchi/current/skills/anchi` (or `$ANCHI_INSTALL_ROOT/current/skills/anchi`
for a custom install root). Inspect `SKILL.md` and its references there, then copy the directory
to **one** of your agent's skill locations. The following refuses to overwrite an installed skill:

```bash
# Claude Code; for Codex, use ~/.codex/skills instead.
mkdir -p ~/.claude/skills
if [ -e ~/.claude/skills/anchi ]; then
  echo 'Anchi skill already exists; review and back it up before replacing it.'
else
  cp -R ~/.local/share/anchi/current/skills/anchi ~/.claude/skills/anchi
fi
```

Releases before 0.3.4 did not include it: fetch the skill from the tag matching
`anchi --version` instead, and run the copy step from the checkout's root (`main` can
document unreleased commands). For example, for Anchi 0.3.4:

```bash
git clone --depth 1 --branch v0.3.4 https://github.com/jwfing/anchi.git anchi-skills-v0.3.4
cd anchi-skills-v0.3.4
cp -R skills/anchi ~/.claude/skills/anchi
```

If you already have a source checkout, copy from its root and use the CLI from that checkout.
After `anchi update`, review the changes under `current/skills/anchi` and explicitly replace
your installed copy. The copy does not auto-update. Check `anchi <command> --help` when the
installed binary and skill disagree.

## Inside Anchi task cells

A cell cannot administer the host. The `anchi` CLI workflows in this skill require host access;
inside a cell, use only the exposed `anchi_*` MCP tools for delegation and task status, within
that agent's permissions. Installing this skill does not grant connectors, delegates, shell
access to the host, or approval authority.

If its reference material is useful for a cell agent, install the shipped copy, or a matching
release from GitHub:

```bash
anchi skills add ~/.local/share/anchi/current/skills/anchi
anchi skills add https://github.com/jwfing/anchi/tree/v0.3.4/skills/anchi
```

Then select the skill in the agent's settings. A directory is copied as it is at that moment;
GitHub skills are pinned to the fetched commit.
A release-tag URL stays on that release; a `main` URL tracks development when you explicitly
run `anchi skills update` and review the changes. Neither updates without your action.

## Maintenance

`references/cli.md` is generated from CLI help: run `python3 scripts/gen-skill-cli.py` after a
command change. `make check` checks drift. Keep `SKILL.md`, configuration, TUI and troubleshooting
references synchronized with user guides, including every runtime's first-run path.
