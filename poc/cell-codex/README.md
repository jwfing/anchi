# PoC: agent image layer + Codex and git in a per-task cell

Builds on [cell-proxy](../cell-proxy/). It checks two things:

1. Can an agent image be a layer built inside a proxy-only build cell?
2. Do Codex and git run as the agent user in a disposable cell, with placeholder credentials only?

| File | Role |
|---|---|
| `lib.sh` | Proxy lifecycle and cell flags (guest root) |
| `build-layer.sh` → `cell-build.sh` | Builds `/var/lib/anchi-poc/layers/codex/upper` over the base rootfs, inside a build cell |
| `run-codex.sh` → `cell-run-codex.sh` | Mounts `layer:base` read-only, starts a `--volatile=overlay` cell as `agent`, runs git and `codex exec` |

```bash
limactl copy -r cell-codex secure-vm:/tmp/anchi-codex
limactl copy ../egress-proxy/anchi_inject.py secure-vm:/tmp/  # then install into /opt/anchi-poc
limactl shell secure-vm -- sudo bash /tmp/anchi-codex/build-layer.sh
limactl shell secure-vm -- sudo bash /tmp/anchi-codex/run-codex.sh
```

Requires `vm-setup.sh` from `cell-proxy` first.

## Real-credential run (user only)

Without arguments, the proxy uses fake GitHub and Codex tokens. To run with real ones, the user runs the command below. Values are expanded by the user's shell and never printed.

```bash
limactl shell secure-vm -- sudo env \
  ANCHI_POC_CODEX_ACCESS_TOKEN="$(jq -r .tokens.access_token ~/.codex/auth.json)" \
  ANCHI_POC_CODEX_ACCOUNT_ID="$(jq -r .tokens.account_id ~/.codex/auth.json)" \
  ANCHI_POC_GITHUB_TOKEN="$(gh auth token)" \
  bash /tmp/anchi-codex/run-codex.sh
```

PoC caveat: inside the VM the tokens appear briefly on the `sudo` command line, and they stay in the transient proxy unit's environment, readable by guest root through `systemctl show`. The proxy unit is stopped when the script exits.

## Results with fake credentials (2026-10-06)

### Layer build

12 s; layer size 373 MB (Codex musl binary, git, perl).

| Step | Outcome |
|---|---|
| Proxy CA | Installed into the image trust store with `update-ca-certificates` |
| `apt-get install git` | Ran through the proxy: `deb.debian.org`, all `passthrough` |
| Codex release download | `github.com` → `release-assets.githubusercontent.com`, both `passthrough` |

The release download confirms that `github-git` injection is now scoped to git smart-HTTP paths.

### Task cell

The cell runs as `agent`, uid 1000, with no capabilities, a read-only `layer:base` lower layer and a discarded tmpfs upper layer.

| Check | Outcome | Meaning |
|---|---|---|
| Codex traffic | Every request went through the proxy: `chatgpt.com` (`injected`, `client=placeholder`) and `auth.openai.com` | No bypass. The cell has no other route, and Codex honored `HTTPS_PROXY` |
| Codex endpoints | `codex/models`, `codex/analytics-events`, `ps/mcp`, `ps/plugins/*`, `plugins/featured`, `wham/accounts/check`, `wham/settings/user` | The injection rule must cover all of `chatgpt.com`. Analytics can be denied |
| Token refresh | After upstream 401s, Codex attempted `POST auth.openai.com/oauth/token` 16 times; all were denied with 403 | No new credential can reach the cell. Whether a real access token avoids refresh needs the real-credential run |
| WebSocket | "Falling back from WebSockets to HTTPS transport. workspace routing discovery unauthorized (401)" | Caused by the fake token's 401, not by connectivity. The earlier host-side 401 has the same cause. WebSocket through mitmproxy is still unverified |
| git | `info/refs` injected (`client=none`); GitHub rejected the fake token, then git asked for a username and failed | Injection works without any client credential. The real-credential run should clone |
| Cell wall time | 22 s | Dominated by Codex reconnect retries |

## Results with real credentials (2026-10-06, run by the user)

**Codex completed a turn: it replied `hi` (1,855 tokens). git cloned `openai/codex` in 5 s.** Cell wall time was 11.9 s, including the clone.

| Check | Outcome |
|---|---|
| Credentials in the cell | Placeholders only. Every `chatgpt.com` request arrived with `client=placeholder` and was injected; git requests arrived with `client=none` and were injected on `info/refs` and `git-upload-pack` |
| Token refresh | No `auth.openai.com` request. The earlier refresh storm was caused only by the fake token's 401s |
| WebSocket | `GET /backend-api/codex/responses` was injected. This is the WebSocket upgrade for the model stream, and it works through mitmproxy |
| Account id | The first real run failed with "selected workspace missing from routing discovery". Codex checks the selected account locally against `wham/accounts/check`. Fixed by giving the cell the real account id, which is an identifier and not an authenticator |
| Telemetry | `ab.chatgpt.com/otlp/v1/metrics` passed through **without** a credential, because injection matches `chatgpt.com` exactly and not its subdomains |
| Warnings | No system `bwrap`, so Codex used its bundled copy; `codex-code-mode-host` is missing from the release tarball; Codex refuses to create PATH helpers under `/tmp`. None of these blocked the turn |

## Tool calls and Codex's own sandbox (2026-10-06, real credentials)

**Codex ran a shell tool inside the cell under its own `workspace-write` sandbox.** It wrote `report.txt` (`git log` and `ls` output) in the cloned repository. Its attempt to create `/etc/anchi-probe` failed with `Read-only file system`. That error comes from bwrap's read-only bind; without bwrap, the agent user would get `Permission denied` instead. The turn used 4,563 tokens, and the cell took 15 s including the clone.

| Step | Problem found | Fix in the layer |
|---|---|---|
| 1 | The bare `codex-<target>` tarball has no bubblewrap, so `codex sandbox` panicked | Install Debian `bubblewrap` |
| 2 | `codex-linux-sandbox` helper missing: Codex refuses to create it under `/tmp` | Ship a `codex-linux-sandbox` → `codex` alias; agent home at `/home/agent` |
| 3 | `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` | Caused by Ubuntu's `apparmor_restrict_unprivileged_userns=1` (confirmed by a temporary toggle). Fixed by an AppArmor profile granting `userns` to `/usr/bin/bwrap` only; the path matches the binary inside the cell |
| 4 | Shell tool failed: `codex-code-mode-host` not found | Install the full `codex-package-<target>` (codex, code-mode host, bundled bwrap, rg, zsh). Layer grows to 519 MB, including unused voice libraries |

Direct `codex sandbox` probes: `read-only` blocked all writes; `workspace-write` allowed the workdir and `/tmp`, and blocked `/etc`.

**Control run, cell isolation only** (`ANCHI_POC_BWRAP_PROFILE=0 ANCHI_POC_SANDBOX=danger-full-access`, real credentials): the same task succeeded. `report.txt` was written, and `/etc/anchi-probe` failed with `Permission denied`, because the agent user does not own `/etc`. The turn used 2,557 tokens; the cell took 15.6 s. Without Codex's sandbox, the agent can still write anywhere the agent user owns: its home, `/tmp`, and the overlay's writable layer, all of which are discarded with the cell.

**Trade-off still open:** with the bwrap profile, the agent can call `bwrap` itself to get a nested user namespace (uid 0 inside it). Plain `unshare` stays blocked. The profile narrows nested user namespaces to bwrap but does not remove the kernel attack surface. The alternative is to rely on the cell alone and run `--sandbox danger-full-access` with `ANCHI_POC_BWRAP_PROFILE=0`.

## Findings for the design

1. **The proxy must own token refresh for subscription runtimes.** Codex refreshes after any 401. The cell must never perform a refresh, and the PoC denial works. The trusted side therefore has to keep the injected access token fresh, using the refresh token it holds and never the cell.
2. **The Codex injection scope is a whole host, not one API.** Model calls, plugins, MCP and analytics all share `chatgpt.com`. Per-path allowlists are possible but brittle across Codex releases. Prefer host-wide injection, plus an explicit deny list (analytics, account settings writes).
3. **Identifiers may enter the cell; authenticators may not.** Codex needs the real ChatGPT account id locally. The invariant should be phrased in terms of credentials that authenticate (tokens, keys, refresh tokens), not every account attribute.
4. **Codex's own sandbox inside the cell is untested.** The bundled bubblewrap was not exercised by a read-only "hi" turn. Next: run a tool-using turn, and decide whether to rely on the cell alone (`--sandbox danger-full-access`) or make nested bubblewrap work.
5. **Building an image layer in a build cell is practical.** No credentials are involved and every fetch is logged, so the build is auditable. Layers are large (373 MB with the Codex binary); share common tools in a base layer.

## AWS: SigV4 re-signing from a task cell (2026-10-06, real credentials)

`build-layer.sh aws` builds an AWS CLI v2 layer: 7 s, 269 MB. `run-aws.sh` runs the CLI as `agent`. The cell holds only placeholder keys; the proxy re-signs every SigV4 call with the real key.

| Call | Protocol | Result |
|---|---|---|
| `sts get-caller-identity` | Query (body `Action=`) | Returned the real IAM user ARN |
| `ec2 describe-regions` | Query, regional endpoint | 17 regions |
| `logs describe-log-groups` | JSON (`X-Amz-Target`) | Real log groups |
| `s3 ls` | REST | Real bucket list |
| `iam create-access-key` | Query | Proxy `AccessDenied` (AWS error shape) |
| `sts get-session-token` | Query | Proxy `AccessDenied` |
| `sts assume-role` | Query | Proxy `AccessDenied` |

There was no `SignatureDoesNotMatch` anywhere, so re-signing is correct for all three protocol families. The deny probes use arguments AWS itself would reject (nonexistent user, invalid MFA, nonexistent role), so a failed denial could not have minted anything.

Fixes made on the way:

- Unsigned `*.amazonaws.com` requests now pass through. The AWS CLI installer download had hit the AWS rule and failed closed with 502.
- Denials now return the service's error shape (XML or JSON) instead of plain text. The AWS CLI had reported plain text as an unparsable response and suggested retrying.

Not covered: S3 uploads (`ANCHI_POC_S3_BUCKET`). Recent CLIs default to streaming checksums (`STREAMING-UNSIGNED-PAYLOAD-TRAILER`), which the proxy currently refuses together with signed `aws-chunked`.

Design implication: the key used here is a long-lived IAM user key that can read production logs and buckets. The proxy keeps it out of the cell, but any agent granted the AWS connector can use everything that key allows, except the denied operations. Agents should get a dedicated least-privilege principal. The proxy deny list complements IAM policy; it does not replace it.
