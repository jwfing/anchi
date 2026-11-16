# Host placement: Anchi without a VM

By default the Anchi daemon drives a Lima VM, where agents run in task cells. The host placement is for a different use: your own `claude` and `codex` sessions, on your own computer, with no VM. Anchi's egress proxy, vault and approvals run on the computer as you; Claude Code's and Codex's own sandboxes keep each session's commands away from the vault and the network, so that every request leaves through the proxy, with placeholders where a credential would be. The design and what was verified are in [the plan](architecture/HOST_PLACEMENT_PLAN.md).

```text
your terminal / IDE
  claude ──(its sandbox: httpProxyPort)──┐
  codex  ──(its proxy ⇒ HTTPS_PROXY)─────┤
                                         ▼
             Anchi egress proxy  127.0.0.1:18180      ~/.anchi/host/
               credentials ◄── auth service ◄── vault (encrypted, your key)
               high-risk writes ──► approvals ──► desktop app, TUI, anchi approvals
                                         ▼
             GitHub, AWS, Linear, … and the model API (your own login, untouched)
```

What you get:

- the credentials you connect (GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord) stay in the vault; a session's commands see `anchi-placeholder` values and the proxy injects the real ones on matching requests only;
- `push main`, secret endpoints and the other high-risk operations wait for your decision, as for agents; a connector in the profile's `ask` list holds every write;
- the audit log of what sessions reached, in `~/.anchi/host/audit.jsonl`;
- no Lima, no VM image, no change to how you start a session.

What you do not get: agents, triggers, delegation and teams, which need a cell. A host-placement daemon refuses `tasks.create` (`HOST_PLACEMENT`). The boundary is also weaker than a VM's; read [Boundary](#boundary) before relying on it.

## Requirements

- macOS or Linux with Python 3.11 or newer on `PATH` (`python3`, or a versioned `python3.12`), with its `venv` module. macOS does not ship one: install it from python.org or with Homebrew.
- Claude Code 2.1.285 or newer, or Codex CLI 0.166 or newer, installed as you use them. Claude Code's sandbox needs `bubblewrap` and `socat` on Linux (see its `/sandbox` panel); on macOS it uses Seatbelt.
- An Anchi checkout or release install, as for the VM placement.

## Set up

The daemon chooses its placement from `ANCHI_GUEST` when it starts. Stop a running daemon first (`anchi daemon stop`); its Anchi home is shared, so connected accounts are kept, but the vault of the host placement is separate from the VM's.

```bash
export ANCHI_GUEST=host
anchi daemon start                 # or: ANCHI_GUEST=host anchi daemon install, for login start
anchi setup install                # scripts/host-install.sh: a venv under ~/.anchi/host with the pinned mitmproxy
anchi setup vault init             # or vault unlock, with the key in ~/.config/anchi
anchi connectors set github        # the connectors you want sessions to use, as usual
anchi host enable                  # writes the sandbox settings and the shims, after confirmation
export PATH="$HOME/.anchi/host/bin:$PATH"   # in your shell profile, so claude and codex find the shims
anchi host status
```

`anchi setup prepare --runtime codex` does the install and vault steps in one go; the runtime it names is not built, since sessions use your own installs. In the desktop app, **Settings → Security & recovery** shows the card **This computer, no secure room** with **Check & repair** and **Enable**, which asks in a system dialog before writing.

What `anchi host enable` writes, each recorded in `~/.anchi/host/managed.json` so that `anchi host disable` restores it:

| File | Keys | Refused when |
|---|---|---|
| `~/.claude/settings.json` | `sandbox.enabled`, `sandbox.allowUnsandboxedCommands: false`, `sandbox.autoAllowBashIfSandboxed`, `sandbox.network.httpProxyPort`, `sandbox.filesystem.denyRead`, and `env.SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, `AWS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` for the proxy's CA | the file has a `sandbox` block Anchi did not write |
| `~/.codex/config.toml` | `default_permissions = "anchi"` at the top, and a marked block at the end: `[features.network_proxy]`, `[permissions.anchi]` (`extends = ":workspace"`, the same `deny` paths, network enabled without SOCKS) | `default_permissions`, a `permissions.anchi` profile or `network_proxy` is already configured |
| `~/.anchi/host/bin/claude`, `codex` | Shims that set `HTTPS_PROXY`, the CA variables and the placeholder variables (`GH_TOKEN`, `AWS_ACCESS_KEY_ID`, `LINEAR_API_KEY`, …) and run the real command found later on `PATH` | — |

The denied paths are `~/.anchi/host`, `~/.config/anchi`, `~/.ssh`, `~/.aws`, `~/.config/gh` and `~/.netrc`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` in the daemon's environment move the two files.

`~/.anchi/host/profile.json` holds the choices: `port` (default 18180), `ask` (connectors whose every write waits for approval) and `egress` (hosts sessions may reach, or null for any public host). Restart the daemon after changing it, or connect a connector, which registers the sessions again.

## Use

Type `claude` or `codex` as before. Inside a session:

- `curl https://api.github.com/user -H "Authorization: Bearer $GH_TOKEN"` works, with the vault's token injected by the proxy; `echo $GH_TOKEN` prints `anchi-placeholder-github`;
- `git push` to a protected branch, a secrets endpoint or another high-risk operation waits for your decision in the desktop app's **Needs you**, the TUI's Approvals view or `anchi approvals`; unanswered, it is refused after the configured timeout;
- `cat ~/.ssh/id_ed25519`, a raw socket or a `curl --noproxy` fail: the sandbox denies them;
- `git` over SSH fails: SSH does not pass through the proxy; use HTTPS remotes.

Claude Code's own `allowedDomains` does not apply once `httpProxyPort` is set; the proxy's egress list (the profile's `egress`) is what limits destinations. Codex's own domain rules stay in front of the proxy. The runtime's model traffic passes through the proxy with your own login, untouched and unaudited as a credential of its own.

`anchi host status` says whether the install, the services and the settings are in place, and whether the shim directory comes first on `PATH`. Tools that bundle their own `claude` binary (some IDE extensions) do not pick the shim up; their commands still go through the sandbox proxy, but their model traffic and placeholders are not set.

## Boundary

What holds, with the sandbox on and the settings written:

- A command the runtime runs cannot read the vault, the key or the denied paths, cannot open a direct connection or resolve a name, cannot reach a Unix socket, and cannot write outside the working directory and temporary directories.
- Every request such a command makes passes the proxy's egress rules, credential injection, high-risk approvals and audit; the command and the model see a placeholder, never the credential.

What does not hold, stated also in [SECURITY.md](../SECURITY.md):

- The runtime process and its built-in tools run outside the sandbox: Claude Code's Read, Edit, WebFetch and WebSearch, its MCP servers, hooks and `!` commands; Codex's web search, MCP servers, apps, browser and computer use. A prompt-injected WebFetch can send what the Read tool read.
- You can turn the sandbox off, exclude commands (`sandbox.excludedCommands`, reported by `anchi host status`) or approve Codex's escalation to run unsandboxed. Anchi's settings turn Claude Code's unsandboxed retry off.
- Both sandboxes are user-space: no separate user, a shared kernel, and no protection from software you run outside them. The proxy's loopback port is reachable by every process of yours, which is the model: your processes are trusted, the sandboxed commands are not.
- TLS trust is per tool: tools that ignore the CA variables fail to verify (Apple's bundled Python among them; pass `cafile` explicitly), and Go tools under Seatbelt need Claude Code's `enableWeakerNetworkIsolation`, which widens the boundary.
- The vault's key, while unlocked, is a file under `~/.anchi/host/state/run` (mode 0600), not memory-only as in the VM, and the computer's swap is not disabled.

## Remove

```bash
anchi host disable            # restores the two settings files and removes the shims
anchi daemon stop
rm -rf ~/.anchi/host          # the venv, the proxy's CA, the audit log and the vault of this placement
```

Start the daemon without `ANCHI_GUEST` (or `anchi daemon install` again without it) to go back to the VM placement.
