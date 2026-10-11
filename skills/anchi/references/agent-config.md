# Agent files, templates, recipes and settings

Everything lives under `~/.anchi/` (or `ANCHI_HOME`). The daemon reloads files as soon as they are saved, without a confirmation: an edit that loosens an agent's limits takes effect at once (see rule 3 in SKILL.md). `anchi agents` lists agents and the error of any file it cannot load.

## Agent file: `~/.anchi/agents/<id>.yaml`

The file name is the id: 1–40 lowercase letters, digits or `-`. Unknown fields are errors.

| Field | Default | Meaning |
|---|---|---|
| `name`, `description` | the id, none | Shown in the TUI |
| `runtime` | required | `codex`, `claude-code` or `hermes` |
| `model` | runtime default | e.g. `gpt-5.5` (Codex), `claude-sonnet-5-5` or `claude-opus-5-5` (Claude Code), any model of the stored endpoint (Hermes), such as `nousresearch/hermes-4-405b`. A letter or digit first, then letters, digits and `. _ - : / @ +` |
| `effort` | runtime default | `low`, `medium`, `high`, `xhigh` (Codex only) |
| `prompt` | `{mode: append, text: ''}` | `text`, or `file` relative to this file. `mode: replace` replaces the runtime's base instructions (Hermes: the prompt becomes its persona either way) |
| `connectors` | `[]` | Any of `github`, `aws`, `linear`, `gmail`, `drive`, `notion`, `slack` |
| `accounts` | `{}` | Named Google account for `gmail` or `drive` (`{gmail: work}`), which must also be in `connectors`; `default` otherwise |
| `approvals` | `{}` | `{github: ask}` holds every write of that connector for the user |
| `highRisk` | none | `{disable: [github-merge]}`: these high-risk operations no longer wait for this agent |
| `egress` | open | Host patterns the cells may reach besides the runtime's and connectors' hosts, e.g. `[registry.npmjs.org, '*.pypi.org']` |
| `workspaces` | `[]` | `{path, mode?, name?}` under `~/AnchiWorkspaces`; `mode` is `ro` (default) or `rw` |
| `skills` | `[]` | Installed skill ids (`anchi skills`); a missing one fails the task when it starts |
| `delegates` | `[]` | Existing agents this one may hand tasks to (not itself) |
| `maxTasks` | `3` | How many of its tasks run at once (1–10); more wait in its queue |
| `triggers` | `[]` | See below; `text` may use `{title}`, `{url}` and `{id}` of a polled item |
| `image` | `codex` (the base) | A recipe id in `~/.anchi/images/` |
| `sandbox` | `cell` | `codex-workspace-write` (Codex only) adds Codex's own sandbox |
| `extends` | none | A template id in `~/.anchi/templates/` |

### Examples

A reviewer that only reads GitHub and needs approval for every write:

```yaml
name: Reviewer
runtime: claude-code
model: claude-sonnet-5-5
connectors: [github]
approvals: { github: ask }
egress: []                      # only GitHub and the runtime's own hosts
prompt:
  text: |
    Review the pull request you are given. Comment on correctness and tests.
    Never push, merge or approve.
```

A lead that delegates and runs every weekday morning:

```yaml
name: Lead
runtime: codex
connectors: [github, linear]
delegates: [developer, reviewer]   # agents that exist
triggers:
  - schedule: '0 9 * * 1-5'          # cron, local time; a missed run runs once on wake
    text: Triage new Linear issues and assign them.
  - poll: { type: linear-issues, label: agent }
    every: 10                        # minutes, default 5
    text: 'Handle {title} ({url})'
  - poll: { type: github-issues, query: 'repo:acme/api is:open label:bug' }
    text: 'Fix {title}: {url}'
prompt:
  text: Split work into tasks for your delegates and follow them to the end.
```

A developer on a local checkout, with a model served by OpenRouter:

```yaml
name: Hermes dev
runtime: hermes
model: nousresearch/hermes-4-405b    # optional; the endpoint's default otherwise
workspaces:
  - { path: projects/api, mode: rw }   # ~/AnchiWorkspaces/projects/api
skills: [test-driven-development]  # installed with `anchi skills add`
egress: [registry.npmjs.org]
```

Mail triage on a second Google account, with every write held:

```yaml
name: Inbox
runtime: claude-code
connectors: [gmail, notion]
accounts: { gmail: work }
approvals: { notion: ask }
```

### Notes

- **Egress.** Without `egress` an agent reaches any public host. With it, only the listed hosts plus its runtime's and connectors' hosts; refused hosts are noted in the task, and `anchi agents allow-host <agent> <host>` adds one. Package registries a developer agent may need: `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`, `proxy.golang.org` and `sum.golang.org`, `index.crates.io` and `static.crates.io`.
- **Workspaces.** `rw` lets the agent change files that later run on the user's computer. Anchi masks git hooks, git config and editor configuration read-only and audits each turn for new hooks, executables and symlinks out, but `package.json` scripts and `Makefile`s remain the user's to review.
- **High-risk ids:** `github-merge`, `github-repo-delete`, `github-repo-settings`, `github-repo-transfer`, `github-protection`, `github-access`, `github-ref-delete`, `github-graphql`, `git-default-branch`, `git-ref-delete`, `aws-destroy`, `aws-s3-delete`, `aws-s3-access`, `linear-delete`. `approvals: {<connector>: ask}` still holds writes an exemption covers.
- **Templates.** `extends: base-dev` merges `~/.anchi/templates/base-dev.yaml` key by key; arrays and scalars in the agent replace the template's.

## Image recipe: `~/.anchi/images/<id>.yaml`

```yaml
description: PostgreSQL client and the AWS CLI
packages: [postgresql-client, unzip]          # Debian 12 packages
run:                                          # shell commands, as root, at build time
  - curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/a.zip && unzip -q /tmp/a.zip -d /tmp && /tmp/aws/install
```

The recipe's content hash names the built layer; a changed recipe is built again at the next task. Ids starting with `runtime-` are reserved. The build reaches the network through the proxy without credentials.

## Settings: `~/.anchi/settings.yaml`

| Key | Meaning |
|---|---|
| `retentionDays` | Finished tasks are deleted after this many days (default 90) |
| `codexAutoImport` | `false` stops re-importing the Codex login when it refreshes |
| `maxCells` | Cells working at once across all agents (1–16, default 4); a cell waiting for a task it delegated does not count. Give the VM more memory before raising it much |
| `highRisk: {disable: [...]}` | Exemptions for every agent |

Key bindings: `~/.anchi/keybindings.json` (`anchi keys` shows the merged map).
