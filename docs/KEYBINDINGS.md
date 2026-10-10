# Key bindings

The TUI binds named actions to keys per view. Three rules keep it usable inside other terminal programs:

1. **Every action has a leader binding.** Press the leader, **Ctrl+X** by default, then one key: **^X n** starts a new task. Tmux (Ctrl+B), screen (Ctrl+A), zellij and herdr leave Ctrl+X alone. After the leader, a panel lists the keys that can follow it; **Esc** cancels, and so does a three-second pause.
2. **Views without a text input use plain keys.** The sidebar, task details and the Configure screens bind letters such as **j k / [ ] c D**. In the agent chat, printable keys always type text.
3. **The chat input keeps standard line editing.** Ctrl+A, Ctrl+E, Ctrl+U and the other editing keys do what they do in a shell. They cannot be rebound in the chat.

**^X Space** (or **^X p**) opens the command palette: type to filter every command of the current view, **Enter** runs it. **?** in views without a text input, or **^X ?** anywhere, lists the keys of the current view.

## Defaults

### Everywhere

| Keys | Action |
|---|---|
| Tab, Shift+Tab | Switch between the sidebar and the main pane |
| ^N, ^P (or ^X j, ^X k) | Next / previous sidebar item |
| ^X 1, ^X 2, ^X 3 | Configure, Agents, Tasks |
| ^X 0, ^X 4 | Getting started, Team overview |
| ^X !, ^X L | Persistent problem details, installation log |
| ^X h | Toggle task result and history |
| ^X b | Agent builder |
| ^X n | New task (a new session) for the agent shown |
| ^X c | Cancel the running task after confirmation |
| ^X r | Run a failed or cancelled task again (continue its session, or start over) |
| ^X a | Review a write waiting for approval |
| ^X s | Agent settings: skills, connectors, workspaces |
| ^X D | Delete the agent with its tasks (type its id to confirm) |
| ^X o | Reopen the pending builder proposal |
| ^X l | External access of the task shown |
| ^X t, ^X v | Expand tool calls, verbose tool output |
| ^X / | Filter tasks |
| ^X Space, ^X p | Command palette |
| ^X ? | Keys of this view |
| ^X q, Ctrl+C | Quit (the daemon and running tasks keep going) |

### Agent chat

| Keys | Action |
|---|---|
| Enter | Send; multiline messages open a preview before a second Enter sends |
| Shift+Enter, ^X Enter | Insert a newline (^X Enter works when the terminal cannot distinguish Shift+Enter) |
| Esc | Back to the sidebar; keep the draft and running task |
| ↑ ↓ PgUp PgDn | Scroll the transcript |
| Ctrl+G, ^X e | Compose in `$EDITOR` (also a fallback when an IME misbehaves) |
| ← → ^B ^F, Alt+B Alt+F | Move by character, by word |
| Home End, ^A ^E | Start, end of the line |
| Backspace, ^D | Delete before, at the cursor |
| ^W, Alt+D | Delete the word before, after |
| ^U, ^K | Delete to the start, end of the line |

Drafts, cursor positions and transcript scroll positions are kept per conversation while the TUI stays open. A failed send retains its draft. The composer grows to five lines, wraps Chinese and emoji, and keeps the cursor visible.

### Home

Getting started checks host prerequisites, VM, vault and runtime before guiding you to Agent builder and a first task. **Enter** resumes the next step; **↑ ↓** scroll. Installation continues when you leave the view, and **^X L** opens its log. Agent builder currently uses Codex; Claude agents can be used once configured.

Team overview lists each agent’s current activity, pending approvals and delegated work. **↑ ↓** selects an agent; **Enter** opens it. Finished task details show the result and artifact links first; **^X h** reveals the event history.

### Sidebar

↑ ↓ (j k) move, Home End (g G) first and last, PgUp PgDn ([ ]) task pages, 1 2 3 sections, Enter → (l) open, s agent settings, D delete the selected agent or task, / filter, ? keys, q quit.

### Task

Enter continues the task in its agent's chat, a shows its external access, R runs a failed or cancelled one again, c asks before cancelling it, D deletes it, [ ] turn task pages, ↑ ↓ (k j) PgUp PgDn scroll, Esc ← (h) back to the sidebar.

### Configure

- **Runtimes:** s start the VM, I install, u unlock the vault, V initialize a new vault, W share workspaces, i import Codex, c connect Claude Code, r refresh.
- **Skills:** ↑ ↓ (k j) choose, a add, u update to the latest commit of its URL, d remove.
- **Connectors:** ↑ ↓ (k j) choose, Enter or c connect, g GitHub from gh, p AWS profile, m service writes automatic or ask, d disconnect, r refresh.
- **Usage:** p period (24 hours, 7 days, 30 days), b group by agent, model, runtime or day, r refresh, ↑ ↓ PgUp PgDn scroll.
- **Access:** p period (24 hours, 7 days, 30 days), r refresh, ↑ ↓ scroll.

The access view of a task scrolls with ↑ ↓ PgUp PgDn and closes with Esc; **e** chooses a host the task was refused, to add to the agent's egress list after a confirmation (y).

The agent settings panel uses ↑ ↓ (k j), **Space** to select and **Enter** to review. Pending write approvals appear in the status bar without opening a dialog. Open **^X a**, select **y** or **n**, then press **Enter** to confirm; **Esc** postpones the decision. Confirmation and proposal dialogs use **y**, **n** and **Esc** (and **s** in a proposal for its settings). These dialog keys are not rebindable.

## Changing keys

`anchi keys init` writes `~/.anchi/keybindings.json`; `anchi keys` prints the effective bindings and anything it skipped. The TUI applies changes while it runs.

```json
{
  "leader": "ctrl+x",
  "bindings": [
    { "context": "global", "bindings": { "ctrl+n": null, "ctrl+p": null, "alt+n": "task:new" } },
    { "context": "chat", "bindings": { "ctrl+y": "chat:editor" } },
    { "context": "sidebar", "bindings": { "x": "task:cancel" } }
  ]
}
```

- **Contexts:** `global`, `sidebar`, `chat`, `task`, `welcome`, `team`, `runtimes`, `skills`, `connectors`, `usage`, `access`. A view's bindings come before the global ones.
- **Actions** are named `namespace:action`; `anchi keys` lists them with their titles. `null` removes a binding.
- **Keys:** `ctrl+`, `alt+` (also `meta`, `option`) and `shift+` with a key; `shift+g` is `G`. Named keys: `enter`, `esc`, `tab`, `space`, `up`, `down`, `left`, `right`, `pageup`, `pagedown`, `home`, `end`, `backspace`. A chord is keys separated by spaces (`ctrl+k ctrl+s`, up to three); `<leader>` stands for the leader.
- **Leader:** Ctrl or Alt with a key that does not edit text. Changing it moves every `<leader>` binding.
- **Reserved:** Ctrl+C (quit), and Ctrl+M, Ctrl+I and Ctrl+[, which terminals deliver as Enter, Tab and Esc. In `chat`, the line-editing keys.

Problems are reported, not fatal: the TUI shows how many entries it skipped and keeps the rest.

Terminals deliver no ⌘ keys to terminal programs, so Anchi binds none. Some multiplexers take keys first: zellij uses Ctrl+P, Ctrl+N and Ctrl+G by default, so inside zellij use the leader bindings or rebind.
