# Host placement without Python: the proxy and the vault in TypeScript

**Status: implemented (2026-11-16), steps 0 to 7; step 8 (a live `claude -p` / `codex exec` run through the shims) not yet run.** Deviations from the plan below: certificates are issued with the `openssl` command line instead of `@peculiar/x509` (no dependency in the trusted zone; the same options exist in LibreSSL and OpenSSL), the proxy terminates TLS only for hosts whose connector the principal is granted (deny-only and runtime rules are tunnelled, so the runtimes' own logins and token refreshes pass), and the daemon identifies itself to the control socket with a token file beside the socket, since Node cannot read a peer's UID. Follows [the host placement plan](HOST_PLACEMENT_PLAN.md), whose P1 to P4 run the Python services on the user's computer and therefore need Python 3.11+. This plan replaces that Python side with a TypeScript process, so a host placement needs nothing beyond the Anchi daemon's own Node. The VM placement keeps its Python services unchanged.

Each step below is one pull request a separate agent can take. Steps 1, 2 and 3 are independent of each other; 4 needs 1 and 2; 5 needs 3 and 4; 6 needs 5; 7 and 8 come last. Every step ends with `make check` green and its own tests, written refusal-path first ([`anchi-security-boundary`](../../.agents/skills/anchi-security-boundary/SKILL.md)).

## Goal

- `ANCHI_GUEST=host` works on a machine with Node and nothing else: no Python, no venv, no mitmproxy.
- The same boundary as today's host placement ([docs/HOST_PLACEMENT.md](../HOST_PLACEMENT.md)): a session's sandboxed commands reach the network only through Anchi's proxy; placeholders in, credentials injected on matching requests only; high-risk writes held for approval; every request audited.
- The daemon never holds a credential or the vault key: the new process does, as the Python services do today.
- Encrypted files written by the Python vault stay readable (same envelope), so a host placement set up before this change keeps its credentials.

## Scope

What the host placement uses today, and what happens to it:

| Python today | Lines | TypeScript | Step |
|---|---|---|---|
| `services/egress_rules.py`: rules table, decisions, credential classification, writes and high-risk detection, git push parsing, deny responses, egress lists, public-address check, verification requests | 1063 | `rules/` in the new package, same behavior, same names | 1 |
| `egress_rules.py` AWS SigV4 re-signing and `aws-chunked` streaming re-signer (botocore) | ~130 | `sigv4/` with `node:crypto`, no AWS SDK | 2 |
| `services/vault.py`, `auth.py` (token connectors and AWS only), `vault_admin.py`, `admin.py` (`import-token`, `import-aws`, `disconnect`, `status`, `set-account`) | ~500 of 900 | `vault/` and `credentials/` | 3 |
| `services/egress_proxy.py`: mitmproxy addon (TLS termination, request pipeline, approvals, audit, verify, settings, host principal) | 1371 | `proxy/` on `node:net`, `node:tls`, `node:http` | 4, 5 |
| `services/host_control.py`, `placement.py`, `server.py --listen`, the host branches in the admin scripts | ~350 | removed; the daemon talks to the new process directly | 6 |
| `scripts/host-install.sh`, the venv, `hostPython()` | | removed | 6 |

Out of scope, on purpose: the connector services (Gmail, Drive, Notion, Slack, X, Reddit) and the policy service, which a host placement does not run; Google, X and Reddit OAuth flows in `auth.py`; runtime credentials (Codex, Claude, Hermes rules keep their table entries so decisions stay identical, but no host session is ever granted them); the Codex quota headers and usage fetch; polling triggers (`poll`); the VM placement, `mitmproxy` and `botocore` pins, and everything under `guest/`.

## Architecture

```text
daemon (@anchi/daemon)                         @anchi/host-services (one child process, as the user)
  HostServices.start() ─── spawns ───►  main.ts
  HostTransport ─── control socket ──►   control/   register · settings.set · approvals.* · verify · list · vault.* · credentials.*
                     ~/.anchi/host/state/run/control.sock (0600, peer UID = own UID)
  vault.mjs ── key on stdin ──► cli.ts vault unlock ── control socket ──► vault/  (key in this process only)
                                         proxy/     127.0.0.1:<port>: CONNECT, TLS termination for rule hosts, opaque tunnel for the rest
                                         rules/ sigv4/ credentials/ audit.jsonl
```

Decisions that the steps follow:

1. **One new package, `anchi/packages/host-services` (`@anchi/host-services`), trusted host zone.** It may import `@anchi/protocol` only (`anchi/scripts/check-deps.mjs` gets an entry: never `@anchi/daemon`, `@anchi/core`, `@anchi/cell-runner`, `@anchi/tui`, nor a runtime SDK). The daemon imports its client types, not its runtime.
2. **A separate process, not a daemon module.** The daemon must stay free of secrets (SECURITY.md: secrets reach the trusted side on stdin only; `vault.mjs` is a separate short process so the key is never in the daemon's memory). `host-services` holds the key and the credentials; the daemon reaches it over the control socket with the same operations `anchi-cell` and the Python proxy offer today, so `ApprovalWatcher`, `pushEgressSettings`, `verify` and the setup status need no new concepts.
3. **The host principal is the listener.** No per-cell Unix sockets and no mitmproxy bridge: the proxy listens on the profile's loopback port and every connection is the `host` principal, with the grants, `ask` list and egress list of the latest `register`. The audit rows keep `task: host`, `agent: host`.
4. **TLS is terminated only for hosts that have a rule** (`rules.find_rule`) or are needed for verification; every other CONNECT is an opaque tunnel, still subject to the egress list and the public-address check by name. This is what lets the runtimes' own model traffic (Codex's WebSocket to `chatgpt.com`, Claude's `api.anthropic.com`) pass untouched, and it removes the CA-trust problem for tools that pin certificates.
5. **Certificates with `@peculiar/x509`** (pure TypeScript over WebCrypto; no native module). Node has no API to issue X.509 certificates, and shelling out to `openssl` differs between LibreSSL and OpenSSL. It is the one new dependency; pin it, mind pnpm's minimum release age, and state the reason in the PR. Everything else is Node built-ins. SigV4 is hand-written (the algorithm is small and fully specified) rather than an AWS SDK dependency.
6. **The Python rules stay the source of truth for the remote server's guest.** Parity is enforced with generated fixtures: `scripts/gen-egress-fixtures.py` runs the Python `egress_rules` over a fixed corpus of requests (no secrets: placeholders only) and writes `anchi/packages/host-services/test/fixtures/*.json`; the TypeScript tests replay them. `make check` regenerates the fixtures with the Python it already has and fails on a difference, so a rule change in either language is caught.
7. **Same files, same shapes.** The vault envelope (`version`, `nonce`, `ciphertext`, AAD `secure-vm:v1:<name>`), the credential file names and fields, the audit row fields, the approval item fields and the control-socket JSON lines are kept byte-compatible where the daemon or a user file depends on them. Where a Python detail exists only because of mitmproxy or systemd, it is not reproduced.

## Steps

### Step 0: package skeleton and the control protocol

- Create `anchi/packages/host-services` with `package.json` (`@anchi/host-services`, `type: module`, scripts `test`, `typecheck` like the daemon's), `tsconfig.json`, `src/index.ts`, `src/main.ts` (the process entry: parses `--state <dir> --port <n>`, starts the control socket, exits cleanly on SIGTERM), `test/`. Add the package to the workspace, to `anchi/scripts/check-deps.mjs` (`'host-services': [/^@anchi\/(?!protocol$)/, ...RUNTIME]`) and to the root typecheck and vitest configuration.
- `src/control/protocol.ts`: the JSON-line operations and their parameters and results as TypeScript types with `zod` schemas (`z.strictObject`, bounded strings and arrays): `register` (`{connectors, ask, high_risk_disabled, egress, listen_port}`), `unregister`, `list`, `settings.set`, `approvals.watch` (a stream), `approvals.decide`, `verify`, `vault.status`, `vault.unlock` (`{key}` base64, 32 bytes), `vault.lock`, `credentials.status`, `credentials.import` (`{connector, token}` or the AWS fields), `credentials.remove`, `credentials.setAccount`, `version`. Error codes as today (`BAD_*`, `CALLER_DENIED`, `UNKNOWN_OP`, `CELL_EXISTS`, `UNKNOWN_APPROVAL`, …).
- `src/control/server.ts`: a Unix socket server (path under the state directory, mode 0600, the directory 0700) that reads one line of at most 64 KiB per connection, checks the peer's UID equals the process's own (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` on macOS, through a small `peer.ts` with the same logic as `services/common.py`), dispatches to a handler table, answers `{ok, result}` or `{ok: false, error}`, and keeps `approvals.watch` connections open.
- `src/control/client.ts`: the client the daemon will use (connect, one request, parse; a watch helper that yields lines).
- Tests: a line over 64 KiB, a non-object, an unknown op and a forged UID are refused with their codes; a watch stays open; two clients at once.
- Done when: `pnpm --dir anchi run check` passes with the empty package and the control server answering `version`.

### Step 1: the rules

- Port `services/egress_rules.py` to `src/rules/`: `rules.ts` (the `RULES` table as data with the same names, hosts, kinds, grants, paths and deny patterns, including the runtime rules so that decisions for any host are identical), `decide.ts` (`findRule`, `hermesRule`, `classifyCredential`, `operation`, `decide`, `denyResponse`, `isWrite` with the GraphQL mutation detection and its 1 MB document bound), `highRisk.ts` (`HIGH_RISK` entries by id, `gitPushCommands` with the pkt-line parser and its 64 KiB bound, `gitUpdateSubject`, `graphqlMutationNames`, `highRisk`), `egress.ts` (`EGRESS_PATTERN`, `BASE_EGRESS`, `egressAllowlist`, `egressAllowed`), `address.ts` (`PRIVATE_NETWORKS`, `privateDestination`, `publicAddress` preferring IPv4), `verify.ts` (`VERIFY_ENDPOINTS`, `verifyRequests`, `verifyAccount`, `githubIdentity` with its bounded fields), `apply.ts` (`apply` for kinds `bearer`, `basic`, `raw`, `hermes`, the Claude and Codex replace-only kinds; the AWS kind calls step 2). Keep every regular expression and bound; translate Python byte regexes on `Buffer`s carefully (`git_pkt`, chunk lines).
- `scripts/gen-egress-fixtures.py` and the fixture corpus: for each Python test in `tests/test_egress.py` classes `DecisionTests` and `DestinationTests`, a request shape and the expected decision, risk, write classification, deny response, summary and verify parsing. The corpus holds placeholders and fake tokens only (reuse the Python tests' values); the generator refuses to write a value matching a real credential pattern that is not a placeholder.
- Tests: the fixture replay, plus unit tests for the bounds (a push body over 64 KiB, a GraphQL document over 1 MB, a ref name with a control character) and for `EGRESS_PATTERN` and `publicAddress` with every range the Python tests cover.
- Done when: every fixture passes and `make check` regenerates fixtures without a diff.

### Step 2: SigV4

- `src/sigv4/`: `sign.ts` (canonical request, string to sign, signing key, `Authorization` header; `x-amz-security-token`; `UNSIGNED-PAYLOAD` and precomputed `x-amz-content-sha256` honored as botocore does), `resign.ts` (`awsResign`: strip the headers in `AWS_STRIP`, sign with the vault's keys, keep the request's own `x-amz-date` semantics as the Python does), `chunked.ts` (`ChunkResigner`: the `aws-chunked` seed signature, per-chunk signatures, the trailer with `x-amz-trailer-signature`, the malformed-body refusals, the same `CHUNK_LINE` and `TRAILER` bounds).
- Fixtures: the AWS example vectors already in `tests/test_egress.py` (`test_aws_chunk_signatures_match_the_aws_example`, the trailer test, the streaming payload test) and botocore-generated signatures for a dozen requests across services (S3 with subresources, STS, IAM read, a query-string `Action`), emitted by the step 1 generator from fake keys.
- Done when: the TypeScript signatures equal botocore's on every fixture, and a chunk with a wrong signature, a chunk longer than declared and a missing trailer are refused.

### Step 3: the vault and the credential store

- `src/vault/envelope.ts`: AES-256-GCM with `node:crypto`, the nonce, AAD and base64 fields of `services/vault.py`, so a file written by either implementation decrypts in the other (test with a fixture file encrypted by the Python vault under a fixed key). `src/vault/store.ts`: the key held in process memory only (never written on the host; the Python host branch wrote it to `state/run/master.key`, which this drops), `unlock` verifying the key against every existing `*.json.enc` before accepting it (a wrong key never replaces a working one), `lock`, `status` (`unlocked`, `encrypted_files`), atomic writes (temporary file, `fsync`, rename, directory `fsync`), 0600 files in a 0700 directory, one advisory lock around writes.
- `src/credentials/`: the token connectors with the patterns of `auth.TOKENS`, `importToken` (shape check, `generation`, `imported_at`), `importAws` (the field checks of `auth.import_aws`), `remove`, `status` (no secrets, account labels only), `setAccount`, `egressCredential(connector)` returning exactly the fields the proxy injects. The `EGRESS_CONNECTORS` list as today.
- Control operations `vault.*` and `credentials.*` wired in step 0's handler table. `cli.ts`: `vault unlock|status|lock` reading the key on stdin and forwarding it over the control socket, for `scripts/vault.mjs`.
- Tests: envelope compatibility both ways; a wrong key refused with the encrypted files untouched; token patterns (every connector, a malformed value, an oversize value); the egress credential of an unknown connector refused; the status never contains a token (assert on the serialized output); a crash between the temporary file and the rename leaves the old file.
- Done when: `vault.mjs` with `ANCHI_GUEST=host` can init, unlock, lock and report status against the process from step 0.

### Step 4: the proxy

- `src/proxy/ca.ts`: a CA generated once into the state directory with `@peculiar/x509` (2048-bit RSA or P-256, ten years, `CA:TRUE`), 0600 key, leaf certificates per host signed on demand and cached in memory (one day, SAN = the host). `caBundle()` writes system roots plus the CA, as `HostServices.writeBundle` does today (then move that function here).
- `src/proxy/listener.ts`: `net.createServer` on `127.0.0.1:<port>`; parses the first request line. `CONNECT host:port`: check the egress list and the public-address rule by name; if the host has a rule, answer `200 Connection established`, wrap the socket in `tls.TLSSocket({isServer: true, SNICallback})` and hand it to the HTTP layer; else resolve, check the resolved address, and pipe bytes both ways (opaque tunnel; an `Upgrade: websocket` inside a terminated tunnel is not expected, since rule hosts have no WebSocket use, and is refused). Plain `GET http://…` absolute-form requests go through the same pipeline without TLS. Everything else: `400`.
- `src/proxy/pipeline.ts`: for each request on a terminated connection, in the order of `EgressProxy.handle`: strip `Proxy-Authorization`; the Host header must name the connected host (`host-mismatch` → 400); egress list; `decide`; `deny` → the deny response; `pass` → forward; a streamed body larger than 8 MiB on a non-push, non-S3 request → forward uninjected and audit `pass:streamed`; a git `receive-pack` body → the `PushInspector` equivalent (read the ref updates from the start of the body, refuse a high-risk push with the git-protocol rejection, stream the rest); high risk and `ask` → the approvals queue, `held-denied` / `held-timeout` → 403; then the credential from the store, `apply` (or the SigV4 resign, with the chunked resigner on streamed S3 uploads), and the upstream request over `https.request` to the address checked in `publicAddress`, with `servername` set to the host and the response streamed back. Response headers are passed through unchanged; the audit row has the fields of today's rows and never a header value.
- `src/proxy/audit.ts`: `audit.jsonl` with the 50 MiB rotation. `src/proxy/approvals.ts`: the queue, the timeout from settings, `pending`/`resolved`/`ping` lines on the watch, `APPROVALS_PENDING_MAX`. `src/proxy/settings.ts`: `check_settings` and the settings file. `src/proxy/verify.ts`: `verify(connector)` reading the credential afresh and calling only the identity endpoints.
- Tests, with a local HTTPS upstream started in the test (self-signed, trusted only by the test's agent) and the proxy's own CA: a bearer placeholder becomes the stored token at the upstream and nothing else changes; a credential of the session's own is forwarded unalerted for the host principal; a host outside the egress list is refused before any connection; a Host header naming another host is refused; a push to `main` waits and is refused on timeout; a denied endpoint gets the deny response; an opaque tunnel to a non-rule host passes bytes and refuses a private address; a request to the proxy from a client that is not loopback is impossible (bind test); the audit row of each case; `proxy-authorization` never reaches the upstream; a body over the limit streams uninjected; the chunked S3 upload is re-signed on the way.
- Done when: a `curl` through the listener with the written bundle reaches `api.github.com/zen`, a placeholder is injected for a connected connector, and the metadata address is refused, as the live check of the Python version did.

### Step 5: the process and the operations

- `main.ts` wires steps 0 to 4: state directory layout under `~/.anchi/host/state` (`run/control.sock`, `mitm/` becomes `ca/`, `auth/` for encrypted files, `egress/settings.json`), the listener on the profile's port, `register` (validation as in `Registry.validate`, one principal, `CELL_EXISTS` on a second registration, `unregister`), `list`, `settings.set`, `quota` (answers an empty object), `poll` and anything else unknown refused.
- Startup order: control socket first, then the listener; a listener port in use is reported on the control socket (`PORT_IN_USE`) rather than killing the process. Graceful stop on SIGTERM: stop accepting, let in-flight requests finish for a few seconds, close.
- Memory and limits: bounded request heads (64 KiB), bounded buffered bodies (the 8 MiB streaming threshold), at most a few hundred concurrent connections, approvals pending maximum.
- Tests: an end-to-end run of the process in a temporary directory: unlock, import a token, register, request through the listener, approval over the watch, `unregister`, lock. The control socket refuses another UID (patch the peer function).
- Done when: the daemon-independent end-to-end test passes on macOS and Linux CI.

### Step 6: daemon integration, Python host code removed

- `anchi/packages/daemon/src/host-placement.ts`: `HostServices` spawns `process.execPath` with the package's entry (from the checkout or the release bundle's `lib/`) instead of `mitmdump` and `server.py`; restarts it as today; `installed()` is always true (nothing to install); `HostTransport.exec` for `anchi-cell` and the admin scripts becomes a client call on the control socket with the same results shapes (`approvals watch` → the watch stream as a child-like readable; `verify`, `egress-settings`, `register`, `list`, `reap`, `version`, `vault_admin.py status`, `admin.py import-token|import-aws|disconnect|status|set-account`); the canned answers stay for images, runtimes and `mountpoint`.
- `setup.ts`: `hostReadiness('host')` has nothing to require; `HOST_SETUP_STEPS.install` becomes a no-op step that reports "nothing to install" (or is dropped and `prepareEnvironment` skips it for `host`); `scripts/vault.mjs` host branch spawns the new `cli.ts vault …` instead of `vault_admin.py`.
- Remove: `scripts/host-install.sh`, `hostPython`, `services/host_control.py`, `services/placement.py` and every `placement.` branch in `vault.py`, `auth.py`, `policy.py`, `vault_admin.py`, `admin.py`, `connector_admin.py`; keep `server.py --listen` and `common.peer_uid` on macOS only if still used (they are not: remove them and their tests too, keeping the VM behavior and tests unchanged). `egress_proxy.py` keeps the `listen_port` host principal and `ANCHI_EGRESS_HOST` only if the VM ever needs them; otherwise remove them with their tests. The release packaging (`scripts/package-release.sh`) bundles the new package's build.
- Tests: `daemon/test/host-placement.test.ts` updated for the new transport (a fake control server in the test); `daemon.test.ts` host placement scenario still passes; `tests/` Python suite unchanged in count except for the removed host tests.
- Done when: `ANCHI_GUEST=host anchi daemon start`, `anchi setup vault init`, `anchi connectors set github`, `anchi host enable` work on a machine without Python, and `make check` is green.

### Step 7: documentation and the security model

- `docs/HOST_PLACEMENT.md`: requirements without Python; the CA under `~/.anchi/host/state/ca`; the key never on disk; what is tunneled opaque and what is terminated.
- `SECURITY.md` host placement section: the process boundary (one child process holds the secrets, the daemon does not), TLS termination only for rule hosts, the new dependency.
- `docs/architecture/AGENT_TEAM_CONTRACTS.md` (2): the control-socket operations replace the host `anchi-cell` table; `docs/architecture/REPOSITORY.md`: the new package; `AGENTS.md` layout table: `anchi/packages/host-services`; `CHANGELOG.md` Unreleased; `HOST_PLACEMENT_PLAN.md` status.
- Done when: `docs/` describe the implementation as it is, with exact paths and operation names.

### Step 8: live check

- `scripts/verify-host.sh` runs against the new process: the probes of the spike through a real `claude -p` and `codex exec` (a model call each), checking the audit rows, the refusals and the placeholder, and a connected GitHub token injected (`gh` login imported with `anchi connectors set github --from-gh`).
- Done when: the script passes on macOS; record the run in `HOST_PLACEMENT_PLAN.md`.

## Review checklist (what the reviewer applies to each step)

- A test that fails when the boundary breaks exists for every refusal the step introduces; no test was weakened to pass.
- No credential, key or real token in fixtures, logs, error messages or audit rows; placeholders only. `grep -rn 'ghp_\|sk-ant-\|AKIA' anchi/packages/host-services` finds only placeholder prefixes.
- Bounds on every input from the session side: request head, body, header count and size, pkt-line commands, GraphQL documents, approvals pending.
- Fail closed: unknown connector, host, operation or id → a stable error code, never a default allow.
- The fixture generator ran and `make check` is green on macOS and Linux; the Python suite count only changes where step 6 removes host-only tests.
- No new dependency beyond `@peculiar/x509`, no `../../` imports across packages, `check-deps.mjs` passes.
- Prettier, 100 columns, single quotes; comments say why, in the voice of the neighboring code.

## Risks and open questions

- **Two rule engines.** The remote server's guest keeps Python; the fixture check keeps them equal, but a reviewer must still look at both sides of a rule change. If the host placement becomes the main one, the guest could later run the TypeScript proxy on its own Node, which `guest/cell.env` already pins.
- **TLS termination details.** Clients that send HTTP/2 through a CONNECT tunnel (`curl --http2`) expect ALPN; the terminated side offers HTTP/1.1 only, which `curl`, `git`, `gh` and Node accept. Tools pinning certificates fail on rule hosts, as with mitmproxy.
- **`@peculiar/x509` maintenance.** Pure TypeScript, actively maintained, used by widely deployed projects; still a dependency in the trusted zone. Pin it and review updates like any other.
- **Streaming memory.** mitmproxy buffered up to 8 MiB per request; the Node pipeline must do the same without reading whole bodies into memory above that, especially for S3 uploads re-signed in chunks.
- **Release packaging.** The release bundle must carry the new package's build; the desktop app's bundled daemon spawns it from `lib/`.
