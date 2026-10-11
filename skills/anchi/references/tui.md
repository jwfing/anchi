# The TUI

`anchi` (or `anchi tui`) opens the full-screen client; it starts the daemon if needed. Quitting (**^X q** or Ctrl+C) leaves the daemon and running tasks going.

The leader key is **Ctrl+X** (written **^X**): every action has a leader binding, and after the leader a panel lists what can follow. **^X Space** opens the command palette (type to filter, Enter runs); **^X ?** lists the keys of the current view. In an agent's or a task's view, printable keys type into the input, so actions there need the leader; elsewhere plain letters work.

## Screens

| Screen | Reach it | What it is for |
|---|---|---|
| Getting started | ^X 0 | Prerequisites, VM, vault and runtime, then the builder and a first task; Enter continues |
| Team overview | ^X 4 | Each agent's current activity, pending approvals and delegated work |
| Configure → Runtimes | ^X 1 | s start the VM, I install/update, u unlock the vault, V new vault, W share workspaces, i Codex, c Claude Code, h Hermes, r refresh |
| Configure → Skills | ^X 1 | a add (directory or GitHub URL), u update after reviewing the diff, d remove |
| Configure → Connectors | ^X 1 | Enter/c connect, g GitHub from `gh`, p AWS profile, m service writes auto/ask, d disconnect |
| Configure → Usage, Access | ^X 1 | Tokens and limits; hosts and injections per agent; p period, b grouping |
| Agents | ^X 2 | An agent's view lists its tasks; its input starts a new task |
| Tasks | ^X 3 | A task's view shows its transcript; its input replies to it |
| Agent builder | ^X b | Describe an agent; review the proposed file in a dialog; y writes it |

## Keys worth knowing

| Keys | Action |
|---|---|
| Tab | Switch between the sidebar and the main pane |
| ^N, ^P | Next / previous sidebar item |
| ^X n | New task for the agent shown |
| ^X s | The agent's settings panel (Space selects, Enter reviews the diff) |
| ^X a | Review a write waiting for approval (y / n, Enter confirms) |
| ^X c, ^X r | Cancel the task (after confirmation); run a failed or cancelled task again |
| ^X l | External access of the task shown; e allows a refused host after confirmation |
| ^X h | Switch between a task's result and its full history |
| ^X t, ^X v | Expand tool calls; verbose output with reasoning and plans |
| ^X m | Selection mode: copy text with the mouse |
| ^X D | Delete the agent (type its id to confirm) or the task |
| Enter, Shift+Enter | Send; newline. Multi-line messages show a preview first |
| Ctrl+G | Compose the message in `$EDITOR` |

Key bindings can be changed in `~/.anchi/keybindings.json` (`anchi keys init` writes one; `anchi keys` shows the result). The full list is `docs/KEYBINDINGS.md` in the Anchi repository.

Security dialogs (builder proposals, settings changes, approvals, deletions, secret input) are drawn full-screen by Anchi; agent output cannot imitate them, and they are the only way those changes happen besides the user editing files.
