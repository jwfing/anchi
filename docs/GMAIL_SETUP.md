# Read-only Gmail setup

Gmail is part of the connector registry. See [connectors](CONNECTORS.md) for Drive, Notion, Slack and shared authorization rules.

## 1. Prepare Google OAuth

Enable Gmail API in a Google Cloud project and download an OAuth client JSON of type **Desktop app**, not a service-account file. Keep it outside the repository and never paste secrets into chat.

1. Choose/create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable Gmail API in the API Library.
3. Configure Google Auth Platform app information, audience and test users. Include the intended Gmail account during testing.
4. Create a Desktop app client and download its JSON into a private directory.

The app requests only `https://www.googleapis.com/auth/gmail.readonly`, not send/delete/modify. This scope reads the whole mailbox; the prototype has no sender/folder-scoped authorization layer.

The implementation uses a random host loopback port, state and PKCE. See [native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app). External/Testing applications requesting user-data scopes commonly have seven-day refresh-token expiry; Workspace policy can also restrict access. See [Google OAuth lifecycle](https://developers.google.com/identity/protocols/oauth2).

## 2. Authorize

Initialize once with `python3 scripts/vault.py init`, then unlock after each VM restart:

```bash
python3 scripts/vault.py unlock
python3 scripts/gmail-login.py --client /absolute/path/to/desktop-client.json
# After client configuration has been imported:
python3 scripts/gmail-login.py
```

Select the account and consent in the system browser; the terminal waits up to about ten minutes.

- Client configuration goes through SSH stdin, not shell arguments or logs.
- The VM generates PKCE verifier and OAuth state; the verifier stays in the VM.
- The loopback callback checks state, Host and path, then sends the code through SSH stdin to guest administration.
- The VM exchanges and stores tokens; access/refresh tokens do not return to the host or cell.
- Granted scopes must exactly match `gmail.readonly`; broader previous consent is rejected. Prefer a dedicated OAuth client for this experiment.

```bash
python3 scripts/gmail-login.py --status
bash scripts/gmail.sh status
```

`vault_unlocked` reports vault state. `connected` means local credentials exist, not that Google still accepts them. Invalid refresh authorization sets `reauth_required` and stops Google calls until login. Only an actual read validates external authorization.

Connecting defaults to standing read authorization. Use `bash scripts/policy.sh mode gmail ask` to review each request or `mode gmail auto` to restore automatic authorization. `gmail-read allow|deny` remains a compatibility alias.

## 3. Read from the cell

```bash
bash scripts/gmail.sh list --query 'in:inbox newer_than:7d' --limit 3
bash scripts/gmail.sh read MESSAGE_ID
```

`list` returns IDs; `read` returns bounded headers, snippet and plain text, without attachments or HTML body. Lists are capped at ten. Start with one to three selected messages and treat returned content as untrusted data, never administration instructions. Gmail [list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) and [get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) are separate operations.

## 4. Enforced boundaries

```text
Cell UID 1000 (525288 in the guest host)
 -> /run/secure-gmail/api.sock
 -> Gmail: SO_PEERCRED + fixed read-only operations
 -> auth: token/account generation only for the Gmail service identity
 -> policy: exact action authorization, atomic one-time consumption
 -> fixed Google API HTTPS GET
```

The cell sees connector/inference socket directories, not credential or policy sockets/storage. Editing the CLI cannot expand server permissions. Requests cannot choose arbitrary URLs, accounts, headers or roles. Gmail business logic and execution share a service; independent policy makes deterministic decisions. There is no sending function or hidden send path enabled by chat approval.

Transport rejects private DNS results, pins resolved IPs, verifies TLS hostnames, disables redirects and environment proxies. nftables further limits service UID egress to provider IP/TCP 443. Shared IPs cannot be separated by the kernel; HTTP control remains in the trusted gateway.

## 5. Data protection limits

The vault directory is 0700 and AES-256-GCM files are 0600. The master key stays on the host and enters guest tmpfs only while unlocked; this is not full-disk encryption and guest root remains trusted. See [security foundation](SECURITY_FOUNDATION.md).

Link and 4–8-digit masking is heuristic: it may miss login material or hide dates/amounts. It is not complete DLP. Direct `gmail.sh` and legacy `agent.sh collect` do not invoke a model. Explicitly enabled legacy `agent.sh summarize` sends excerpts to its configured provider; [Pi](PI_AGENT.md) uses its separately configured subscription path. There is no account-level multitenancy or complete OAuth end-to-end audit.

## 6. Disconnect

```bash
python3 scripts/gmail-login.py --disconnect
```

Local token use and pending authorization stop first, followed by a Google revocation attempt. OAuth client configuration remains. On remote failure, `revocation_pending:true` allows retrying the same command. In-flight requests may still finish.

## 7. Verification

```bash
make check
bash scripts/verify.sh
```

The first command runs offline checks; the second checks the installed VM. Provider consent, mailbox reading, token refresh, reauthentication and remote revocation require separate real-account checks. Start with a test account and selected messages. Passing local tests does not establish that Google accepts the current credentials or that every recovery path works.
