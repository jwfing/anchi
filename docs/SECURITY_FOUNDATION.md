# Credential, policy and network services

These trusted services keep credentials, authorization and provider networking outside the agent cell. See [Pi integration](PI_AGENT.md), [connectors](CONNECTORS.md) and the [security model](../SECURITY.md) for their callers and boundaries. Gmail remains read-only; Drive, Notion and Slack expose the documented write operations.

## Encrypted credentials

A separate `secure-auth` UID owns OAuth client configuration, access/refresh tokens, temporary PKCE state and optional model keys. `/var/lib/secure-auth/*.json.enc` uses AES-256-GCM with random twelve-byte nonces and the logical filename as AAD, preventing credential-file substitution. Directory mode is 0700; files are 0600 with atomic replacement and fsync.

The 32-byte master key is `~/.config/secure-vm/vault.key` on the host, mode 0600, outside the repository and VM disk. Unlock sends it through Lima SSH stdin to guest-root administration and stores it only in tmpfs `/run/secure-vault/master.key`. VM swap and service/key-tool core dumps are disabled. Restart requires unlocking again.

```bash
python3 scripts/vault.py init    # Create once; reuse an existing key
python3 scripts/vault.py status
python3 scripts/vault.py lock
python3 scripts/vault.py unlock
```

Plaintext migration encrypts, decrypts to verify, then removes the old file, with no plaintext fallback. A wrong key cannot replace an already-unlocked correct one. Protect a separate key backup; losing it requires reauthorization.

Auth returns Google access tokens only to the appropriate connector identity and model keys only to inference, using kernel `SO_PEERCRED`, not self-declared roles. Refresh is serialized by auth. Reauthorization creates a new account generation, so old exact approvals cannot apply to a different account.

Disconnect removes locally usable tokens before attempting Google `/revoke`. Failure retains encrypted retry material and reports `remote_revoked:false, revocation_pending:true`; it is never returned as an active account token. Repeat disconnect to retry. Lock/disconnect cannot retract in-flight calls.

This is credential-file encryption, not full-disk encryption. Mail workspaces, approval bodies and summaries remain unencrypted. Old disk blocks/backups are not securely erased. Host administrators, running guest root and memory snapshots remain trusted. Keychain/TPM custody and automatic key rotation are not implemented.

## Independent policy and approval

`secure-policy` has its own UID/systemd service and no IP networking. Its socket is hidden from the cell. Connector/inference identities may authorize/consume but cannot approve. Administration enters through trusted host Lima SSH and guest root, then drops to the policy identity.

```text
Cell request -> gateway validates operation/parameters
 -> auth supplies matching credentials and account generation
 -> policy evaluates canonical operation/account/params
    auto: issue a short-lived one-time grant
    ask: return APPROVAL_REQUIRED:<id> and pause
 -> gateway atomically consumes the grant -> fixed provider HTTPS call
```

Grants bind caller service, SHA-256 of the canonical request, account generation, policy epoch, Linux boot ID and expiry. Random ticket hashes are stored; consumption is transactional SQLite. Pending approval expires after ten minutes and issued tickets after sixty seconds. Changed content, account substitution, replay, expiry, revocation, policy change or normal reboot causes rejection.

```bash
bash scripts/policy.sh pending
bash scripts/policy.sh show APPROVAL_ID
bash scripts/policy.sh approve APPROVAL_ID --digest EXACT_DIGEST
bash scripts/policy.sh deny APPROVAL_ID
bash scripts/policy.sh revoke APPROVAL_ID
bash scripts/policy.sh rules
bash scripts/policy.sh mode gmail ask
bash scripts/policy.sh mode inference auto
```

`show` exposes the actual action, including complete model input. Review it before approving the exact digest. Terminal JSON escapes control characters and treats mail as data. Resume the original request after approval; inference uses WAITING_APPROVAL and the same request ID. Uncertain external execution remains UNKNOWN without automatic retry.

Each connector and inference has `auto`/`ask`; missing modes default to `auto`. Mode changes increment the epoch and revoke all unconsumed grants. `ask` means review each request, not permanent denial. All modes retain allowlists, revision binding and quotas. `read <connector> allow|deny` and `gmail-read` remain compatibility aliases. There is no `gmail.send` path.

`/var/lib/secure-policy/policy.sqlite3` stores grants and audit metadata. Authorization cleans request bodies older than seven days and audit older than thirty days; no traffic means no scheduled cleanup. Task/session scopes, multitenancy, Web approval and frozen mail-send/MIME objects are not implemented. Boot ID handles normal cold restart, not same-boot database rollback or complete memory-snapshot rollback.

## Kernel egress control

The cell has a separate network namespace without external routes. Guest nftables `inet secure_vm` filters output by socket UID for IPv4 and IPv6.

| Service | Allowed destinations (TCP 443 only) |
|---|---|
| Auth | Public IPs of `oauth2.googleapis.com` |
| Gmail | Public IPs of `gmail.googleapis.com` |
| Drive | Public IPs of `www.googleapis.com` |
| Notion | Public IPs of `api.notion.com` |
| Slack | Public IPs of `slack.com` |
| Inference | Public IPs of `api.openai.com`, `chatgpt.com` |
| Policy and mapped agent UID 525288 | No IP egress |

Connector destinations come from `services/connectors.py`. Each controlled UID has a final reject covering all other TCP/UDP/DNS/private/host/IPv6 paths. Guest management users/root retain networking and must not be exposed to the agent.

Only a root updater resolves fixed provider domains. Every resolved address must be public. It atomically updates nft sets and `/run/secure-egress/targets.json`. Services connect to numeric targets without DNS while using the original hostname for TLS SNI/certificate verification. Egress initialization is a startup dependency.

Refresh runs every two minutes; target files expire after four and kernel entries after five. On refresh failure, old valid targets work only until expiry; no direct-connect fallback opens. Trusted code constructs fixed method/path requests with no redirects, environment proxies or arbitrary CONNECT tunnel.

Kernel IP/port checks cannot distinguish domains/APIs sharing an IP. HTTP paths and bodies remain the gateway's responsibility; a compromised gateway could misuse another service on an allowed IP. There is no independent L7 proxy or taint tracking. These controls must not be generalized into a claim about arbitrary browser safety.

## Verification and limits

```bash
make check
bash scripts/verify.sh
```

Offline tests cover service logic; VM checks exercise deployed identities, sockets, credentials, approvals and network isolation. Provider account lifecycle, malicious-content behavior and recovery need separate checks. Do not infer real-account readiness or complete prompt-injection protection from passing infrastructure tests.

The agent entry point is `scripts/pi.sh`. Current limitations, including snapshot rollback, trusted administrators and cloud disclosure, are described in the [security model](../SECURITY.md).
