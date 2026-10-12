# Your first task

Goal: run one task with one runtime, without connecting a business account or sharing files.
Complete [installation, VM setup, vault unlock and one runtime connection](GETTING_STARTED.md#set-up-the-vm-and-your-first-agent)
first. The task consumes model quota or API credit; creating the starter does not.

The starter command is **unreleased**. Until the next binary release, use a source checkout and
replace `anchi` with `scripts/anchi`, or use the [manual agent file](AGENT_TEAM.md#write-an-agent-file)
on a released binary.

## Create and inspect the agent

Use the runtime you connected (`codex`, `claude-code` or `hermes`):

```bash
anchi agents create dev --runtime claude-code --preview
anchi agents create dev --runtime claude-code
```

Review the YAML and confirm. The starter grants no connectors or workspaces, uses `egress: []`
(runtime hosts only) and runs one task at a time. An existing `dev` is never overwritten; choose
another id. In the TUI, **Ctrl+X, N** selects a runtime and name, then shows the proposal;
**y** saves, **n** discards. **Esc** closes the dialog without saving.

## Run and verify

```bash
anchi run dev "Explain what tools you have access to. Do not change anything."
anchi tasks --agent dev
```

The first task for a runtime builds its image, which can take several minutes. The response
varies by model. Success means a response, exit code 0 and task status `done`; no GitHub token,
repository or connector is needed. A response's claims about access are not authoritative:
`anchi agents` and the access report describe the actual configuration and network activity.

Copy the `t-…` id from the output to continue or inspect the task:

```bash
anchi send <task-id> "Summarize that in three sentences."
anchi audit <task-id>
anchi tasks --agent dev --json
```

`tasks --json`, `agents --json` and `approvals --json` emit arrays, including `[]` for no results.
These list flags are unreleased with the starter command. `run`, `send` and `retry` stream text
and return a nonzero exit code when the turn does not finish successfully.

## If it does not finish

| Symptom | What to check |
|---|---|
| `unknown command 'create'` | Use the source checkout or manual file above; your installed binary predates the starter command. |
| Missing/stopped VM | `anchi setup status` summarizes the environment (`--json` for every field). Finish `anchi setup install` or start an existing VM with `anchi setup vm`. |
| Locked vault | `anchi setup vault unlock`; keep the original vault key. Replacing it cannot decrypt stored accounts. |
| Runtime not configured or expired | Connect the runtime named in `anchi agents`, in **Runtimes** or via `anchi setup`. A Claude/Hermes starter does not need Codex. |
| Image build failed | **Ctrl+X, L** shows setup logs; inspect the task error. Retry after fixing the reported dependency or network problem. |
| A host is refused | This starter intentionally allows runtime hosts only. Check `anchi audit <task-id>` and decide whether the job needs more access. Do not remove the list just to silence an error. |
| Task failed or was cancelled | Inspect the error, then `anchi retry <task-id>` to continue; `--fresh` creates a new task with the original request. |

More error explanations: [Troubleshooting](../skills/anchi/references/troubleshooting.md).
Report reproducible problems through [Issues](https://github.com/jwfing/anchi/issues/new/choose)
with your OS, `anchi --version`, synthetic steps and a redacted error. Do not post credentials
or private task content.

## Add a real job

After this succeeds, choose one next step:

- [Share a project folder](AGENT_TEAM.md#directories-of-your-computer-workspaces). Start with
  `ro` for review. `rw` edits real host files; review them before executing code on the host.
- [Connect GitHub or another service](AGENT_TEAM.md#connect-accounts) and grant that connector
  to the agent. For GitHub writes requiring your review, set `approvals: {github: ask}`.
- [Create another agent](AGENT_TEAM.md#create-agents) and explicitly configure `delegates` for
  collaboration. A name alone does not grant delegation access.

Remove a trial agent with `anchi agents rm dev` after reviewing the deletion preview. It
removes that agent's tasks and VM files; host workspace files are kept.
