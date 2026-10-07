# Host directories for agents: proposal

**Status: decided on 2026-10-07 (option A, `~/AnchiWorkspaces`, macOS first); H0 done.** It refines [Work directories](AGENT_TEAM_DESIGN.md#work-directories) of the design. Today the VM has no host mounts (`lima/secure-vm.yaml`: `mounts: []`), and the desktop app's directory grants were removed with the app.

## Goal

Let an agent work on directories of the Mac, for example a repository you also edit locally, without exposing the rest of the host:

- per agent, only the directories it is configured with;
- read-only by default;
- writes possible, with the risk stated and the obvious host-code-execution paths closed.

## Design

1. **One host root, mounted once.** Lima mounts `~/AnchiWorkspaces` (configurable, created if missing) into the VM at `/mnt/anchi-host`, through virtiofs on macOS and 9p on Linux. Directories you want to share live in, or are moved into, that root. Changing which directories an agent sees then needs no VM restart; only the first setup does.
2. **Per-agent bind mounts.** Agent configuration names subdirectories of the root:

   ```yaml
   workspaces:
     - path: projects/webapp     # relative to ~/AnchiWorkspaces
       mode: rw                  # ro (default) or rw
   ```

   The cell manager bind-mounts each at `/home/agent/workspaces/<name>`, read-only unless `rw`. Paths are validated in the daemon and again in the guest: relative, no `..`, no symlink components, existing directory inside the root. A cell sees nothing else of the root.
3. **Closing host-code-execution paths for `rw`.** A writable repository lets an agent plant code that later runs on the Mac as you. Inside the cell, these are mounted read-only (or masked with an empty directory) over the writable bind:
   - `.git/hooks/` and `.git/config` (hooks, `core.hooksPath`, `core.fsmonitor`, filters and aliases all run commands);
   - `.git/info/attributes`, `.gitattributes` (filter drivers);
   - `.envrc`, `.vscode/`, `.idea/`.

   Files that tools run by design (`package.json` scripts, `Makefile`, test files) cannot be masked without making the directory useless. The TUI states this when an `rw` workspace is configured, and the agent header shows `rw` workspaces.
4. **Ownership.** Files written by the agent appear on the Mac as owned by you, which is how virtiofs maps them. The spike below checks that the user-namespaced cell UID can read and write through the bind.
5. **Unchanged invariants.** No credential enters the mount: the mount is outside the vault, and the credential scan also walks the mounted directories. Credential isolation is still not data isolation: an agent can send what it reads in the workspace to any public host, including `.env` files you keep there.

## Options for writes

| Option | How | Trade-off |
|---|---|---|
| **A. Direct `rw` bind** (proposed) | Writes go straight to the Mac, with the masks above | Simple; you see changes live. Risk limited to files run by design |
| B. Reviewed apply | The workspace is mounted read-only under an overlay whose upper layer stays in the VM; at the end of a turn the daemon shows the diff and applies it to the Mac only after `y` | No unreviewed byte reaches the Mac; more work, large diffs are hard to review, and the agent cannot see your concurrent edits |
| C. Git only | No mount; agents clone and push as today | Already works; not for non-git folders |

## H0 spike results (2026-10-07, macOS, Lima 2.2.0, virtiofs)

- Lima mounts `~/AnchiWorkspaces` at `/mnt/anchi-host`. virtiofs presents files as owned by whoever accesses them; files the cell's agent creates are owned by you on the Mac.
- Bound into a user-namespaced cell: read and write work; a read-only bind refuses writes; read-only binds over `.git/hooks` and `.git/config` refuse changes; the cell sees only its binds.
- git refuses the repository ("dubious ownership") because of that ownership mapping. Cells set `safe.directory=*`: the check protects a trusting user from an untrusted repository, and inside the cell the agent is the untrusted side.
- A symlink in the workspace pointing to `/etc/hosts` resolves inside the VM, not on the Mac. But the agent can create symlinks, which then exist on the Mac (`rootlink -> /`).
- Masks cover repositories that exist when the cell starts. A repository the agent creates during a turn has a writable `.git/config`.

These two gaps become a post-turn **workspace audit**: after each turn the daemon lists, for every `rw` workspace, new or changed git configuration with command-running keys (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`, `filter.*`, `diff.*.command`, `credential.helper`, `alias.*` starting with `!`), new hooks, symlinks pointing outside the workspace and files that became executable. Findings are recorded in the task transcript and shown in the TUI. Anchi never changes your files to fix them.

## Milestones

| Step | Content |
|---|---|
| H0 spike | virtiofs mount into the VM, bind into a user-namespaced cell: read, write, ownership on the Mac, symlink behavior, a `git status` on a large repository |
| H1 | Lima mount and a setup step (`anchi setup workspaces`, one VM restart); `workspaces` in the agent schema; validated binds with masks in `anchi-cell start`; `safe.directory`; post-turn workspace audit |
| H2 | TUI: workspaces in the agent header and a warning for `rw`; builder support; docs and security model |
| H3 | `make verify-anchi` checks: unlisted directories invisible, `ro` enforced, masks effective, no escape through symlinks or `..` |

## Decisions

Confirmed on 2026-10-07: option A for writes, the root `~/AnchiWorkspaces`, macOS first (Linux hosts get no workspaces until 9p is checked).
