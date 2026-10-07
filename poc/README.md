# Agent team PoC summary

Throwaway spikes run on 2026-10-06 to retire the technical unknowns in the [agent team design](../docs/architecture/AGENT_TEAM_DESIGN.md) before phase 1. The setup was an Apple Silicon host with the `secure-vm` Lima VM (Ubuntu 24.04, systemd 255) and a Debian 12 cell rootfs.

Real-credential runs were started by the user. Real values were expanded only in the user's own shell, so the PoC code and the assistant never handled them.

| Directory | Spike |
|---|---|
| [`egress-proxy/`](egress-proxy/) | mitmproxy addon: credential injection, AWS SigV4 re-signing, deny lists, destination filtering. Offline tests |
| [`cell-proxy/`](cell-proxy/) | Proxy inside the VM, reached from a `--private-network` cell through a Unix socket. Cell start-up timing |
| [`cell-codex/`](cell-codex/) | Agent image layers built in a build cell. Codex, Claude Code, git and the AWS CLI run in task cells |

## Verdict

**The design holds.** Every phase 1 and phase 2 mechanism worked end to end, with real accounts, while the cell held only placeholders. No result requires changing the architecture. Several results change details of the design, listed below.

| Question | Result |
|---|---|
| Can a cell with loopback-only networking reach the internet only through the proxy? | **Yes.** A forwarder in the cell relays `127.0.0.1:3128` to a bound Unix socket. Direct TCP, DNS and HTTPS without the proxy all fail. Clients that ignore `HTTPS_PROXY` fail closed |
| Is the passthrough proxy safe from SSRF? | **It was not, and it is now fixed.** The proxy reached the VM's sshd (banner returned) and the Lima host gateway. It now refuses non-public destinations. DNS rebinding remains open in the PoC |
| How fast is a per-task cell? | **About 30 ms** with `--volatile=overlay`, the same as today's read-only cell. `--ephemeral` copies took 1.6–9.2 s on ext4 |
| Can agent images be layers built in a cell? | **Yes.** Overlay upper directories are built inside a proxy-only build cell with no credentials. Codex 519 MB (full package), AWS CLI 269 MB, Claude Code 240 MB; each built in 6–12 s |
| Codex with placeholder tokens? | **Yes, including tool calls.** The model stream uses WebSocket through the proxy. No token refresh with a valid token. The cell needs the real account id |
| Codex's own sandbox in a cell? | **Works only if bwrap gets user namespaces through an AppArmor profile.** Decision: phase 1 defaults to `danger-full-access` and relies on the cell alone |
| Claude Code with a placeholder `CLAUDE_CODE_OAUTH_TOKEN`? | **Yes, including tool calls**, with a `claude setup-token` token. There is no local token-format check. Only `api.anthropic.com` receives credentials |
| git with no client credential? | **Yes.** The proxy injects Basic auth on smart-HTTP paths only. SSH URLs are rewritten to HTTPS in the image |
| AWS with placeholder keys? | **Yes.** Query (STS, EC2), JSON (CloudWatch Logs) and REST (S3) calls were re-signed with no `SignatureDoesNotMatch`. `iam:CreateAccessKey`, `sts:GetSessionToken` and `sts:AssumeRole` return an AWS-shaped `AccessDenied` |
| Do clients bypass the proxy? | **No.** On the host, Claude Code honored `HTTPS_PROXY`. In cells there is no other route |

## Findings that change the design

All of these are reflected in [AGENT_TEAM_DESIGN.md](../docs/architecture/AGENT_TEAM_DESIGN.md).

1. **Cell identity comes from a per-cell proxy socket.** No per-cell IPs, UIDs, veth or NAT are needed.
2. **The proxy filters destinations.** It refuses non-public addresses, must connect to the address it checked (closing DNS rebinding), and gets a kernel-level nftables backstop.
3. **Runtime APIs are replace-only.** The proxy replaces a placeholder and never adds a credential to an unauthenticated request. Claude Code's `mcp-registry` calls had received the token anyway. Connector rules such as git may inject unconditionally.
4. **Identifiers may enter the cell; authenticators may not.** Codex checks the ChatGPT account id locally against routing discovery.
5. **Token refresh belongs to the trusted side.** After a 401, Codex retried `auth.openai.com/oauth/token` 16 times; all were denied. With a valid token it never tried.
6. **Injection scopes need care:**
   - **Codex:** the whole `chatgpt.com` host. Codex uses models, plugins, MCP, analytics and account endpoints there, so per-path lists are brittle.
   - **git:** smart-HTTP paths only. Release downloads must pass through.
   - **AWS:** SigV4-signed requests only. Unsigned public downloads must pass through.
7. **AWS denials must use the service's error shape.** With plain text, the AWS CLI reports an unparsable response and suggests retrying.
8. **Images must install the full Codex package.** The bare `codex` binary lacks `codex-code-mode-host`, and every shell tool call failed. Images also need an agent home outside `/tmp`, because Codex refuses to create helpers there.
9. **AWS least privilege comes from IAM.** Any agent with the AWS connector acts with the configured principal's full authority, minus the deny list. Use a dedicated principal, never a personal key.
10. **Telemetry leaves through passthrough without credentials:** Datadog for Claude Code, `ab.chatgpt.com` for Codex. Deny it per agent if needed.

## Still open

| Item | Where it goes |
|---|---|
| CJK IME input and long transcripts in the Ink TUI | Manual check by the user; first task of phase 1 milestone M5 |
| Concurrent cells and per-cell sockets | Phase 1 M1 (implementation, not a design risk) |
| DNS rebinding: connect to the checked address | Phase 1 M2 |
| S3 uploads with streaming checksums | Later, when an agent needs S3 writes |
| Private-repository clone and `git push` through the proxy | Phase 1 M2 acceptance |
| Linear injection | Phase 1 M6 |

## Leftovers to clean up

- **VM:** `/opt/anchi-poc` (mitmproxy venv and proxy CA), `/var/lib/anchi-poc` (three layers, about 1 GB) and the `anchi-poc` user. Remove with `userdel anchi-poc; rm -rf /opt/anchi-poc /var/lib/anchi-poc` as guest root. No unit or AppArmor profile stays loaded after a run.
- **Host:** `poc/egress-proxy/out/` (proxy CA private key; ignored by git). The long-lived Claude token saved by the user at `~/.config/anchi-poc/claude-token` should be deleted and revoked once no longer needed.
