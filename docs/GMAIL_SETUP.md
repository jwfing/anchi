# Read-only Gmail setup

Gmail is part of the connector registry. See [connectors](CONNECTORS.md) for Drive, Notion, Slack and shared authorization rules. The same Google OAuth client serves Drive.

## 1. Prepare Google OAuth

Sign-in needs an OAuth client. Anchi supports two:

- **Built-in client:** a release may ship Anchi's own Desktop client (`services/google_client.json`, installed readable by the auth service only). When it is present, you can sign in without a Google Cloud project; `scripts/anchi setup status` shows `googleClientSource: "builtin"`.
- **Your own client:** a client you import takes precedence over the built-in one (`googleClientSource: "user"`). `scripts/anchi setup google-client --remove` removes it and falls back to the built-in client. Replacing or removing the client is refused while any Google account is connected (`DISCONNECT_BEFORE_REPLACING_CLIENT`): tokens refresh only with the client that obtained them.

Anchi has not passed Google's verification yet, so releases currently ship no built-in client and you import your own. `gmail.readonly` is a Google *restricted* scope: an app offering it to arbitrary users needs Google's verification and an annual third-party security assessment; until then an unverified client works only for its listed test users. Your own client in Testing mode, with yourself as test user, does not depend on Anchi's verification.

Enable Gmail API in a Google Cloud project and download an OAuth client JSON of type **Desktop app**, not a service-account file. Keep it outside the repository and never paste secrets into chat.

1. Choose/create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable Gmail API in the API Library.
3. Configure Google Auth Platform app information, audience and test users. Include the intended Gmail account during testing.
4. Create a Desktop app client and download its JSON into a private directory.

The app requests only `https://www.googleapis.com/auth/gmail.readonly`, not send/delete/modify. This scope reads the whole mailbox; the prototype has no sender/folder-scoped authorization layer.

The implementation uses a random host loopback port, state and PKCE. See [native-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app). External/Testing applications requesting user-data scopes commonly have seven-day refresh-token expiry; Workspace policy can also restrict access. See [Google OAuth lifecycle](https://developers.google.com/identity/protocols/oauth2).

## 2. Authorize

Unlock the vault first (`scripts/anchi setup vault unlock`), then:

```bash
scripts/anchi setup google-client /absolute/path/to/desktop-client.json   # once, without a built-in client
scripts/anchi setup service gmail
scripts/anchi setup service gmail --account work   # optional: another Google account
```

Select the account and consent in the system browser; the command waits up to about ten minutes.

Several Google accounts can be connected, each under a name of 1–32 lowercase letters, digits, `-` or `_` (at most eight per service). Without `--account` the name is `default`; an account connected before named accounts existed is `default`. Each account has its own tokens and account generation. An agent uses `default` unless its file says otherwise (`accounts: { gmail: work }`); the egress bridge pins that account to the agent's cells, and the Gmail service ignores any account a cell names.

The VM's auth service can reach `oauth2.googleapis.com` only while a Google client is available and a sign-in is in progress, a token is stored or a revocation is pending. Starting a sign-in opens it at once, before you return from the browser.

- Client configuration goes to the VM over stdin, not shell arguments or logs.
- The VM generates the PKCE verifier and OAuth state; the verifier stays in the VM.
- The daemon's loopback callback on 127.0.0.1 checks state, Host and path, then sends the code over stdin to guest administration.
- The VM exchanges and stores tokens; access and refresh tokens never reach the Mac or a cell.
- Granted scopes must exactly match `gmail.readonly`; broader previous consent is rejected. Prefer a dedicated OAuth client.

`scripts/anchi setup status` lists the services. `connected` means local credentials exist, not that Google still accepts them. Invalid refresh authorization sets `reauth_required` and stops Google calls until you sign in again. Only an actual read validates external authorization.

Connecting defaults to standing read authorization. Use `scripts/anchi setup service-mode gmail ask` to review each request, or `auto` to restore automatic authorization.

## 3. Read

Give an agent the connector (`connectors: [gmail]`); it gets the tools `gmail_list` and `gmail_read`. For a manual check without an agent:

```bash
bash scripts/gmail.sh list --query 'in:inbox newer_than:7d' --limit 3
bash scripts/gmail.sh read MESSAGE_ID
```

`list` returns IDs; `read` returns bounded headers, snippet and plain text, without attachments or HTML body. Lists are capped at ten. Treat returned content as untrusted data, never instructions. Gmail [list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) and [get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) are separate operations.

## 4. Enforced boundaries

```text
Cell UID 1000 (525288 in the guest host)
 -> /run/secure-gmail/api.sock
 -> Gmail: SO_PEERCRED + fixed read-only operations
 -> auth: token/account generation only for the Gmail service identity
 -> policy: exact action authorization, atomic one-time consumption
 -> fixed Google API HTTPS GET
```

A cell sees only the socket directories of its agent's connectors, not credential or policy sockets or storage. Editing the CLI cannot expand server permissions. Requests cannot choose arbitrary URLs, accounts, headers or roles. Gmail business logic and execution share a service; independent policy makes deterministic decisions. There is no sending function or hidden send path enabled by chat approval.

Transport rejects private DNS results, pins resolved IPs, verifies TLS hostnames, disables redirects and environment proxies. nftables further limits service UID egress to provider IP/TCP 443. Shared IPs cannot be separated by the kernel; HTTP control remains in the trusted gateway.

## 5. Data protection limits

The vault directory is 0700 and AES-256-GCM files are 0600. The master key stays on the host and enters guest tmpfs only while unlocked; this is not full-disk encryption and guest root remains trusted. See [security foundation](SECURITY_FOUNDATION.md).

Link and 4–8-digit masking is heuristic: it may miss login material or hide dates/amounts. It is not complete DLP. `gmail.sh` does not invoke a model; an agent that reads mail sends it to its runtime's model. There is no account-level multitenancy or complete OAuth end-to-end audit.

## 6. Disconnect

```bash
scripts/anchi setup disconnect gmail                  # the default account
scripts/anchi setup disconnect gmail --account work   # a named account
```

Local token use and pending authorization stop first, followed by a Google revocation attempt. OAuth client configuration remains. On remote failure, `revocation_pending:true` allows retrying the same command. In-flight requests may still finish.

## 7. Verification

```bash
make check
bash scripts/verify.sh
```

The first command runs offline checks; the second checks the installed VM. Provider consent, mailbox reading, token refresh, reauthentication and remote revocation require separate real-account checks. Start with a test account and selected messages. Passing local tests does not establish that Google accepts the current credentials or that every recovery path works.
