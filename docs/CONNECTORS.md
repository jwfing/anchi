# Account connectors

Gmail, Google Drive, Notion and Slack are registered in `services/connectors.py`. Each has its own UID, socket and egress identity. Connecting grants standing authorization by default; each connector can switch to per-request approval. Credentials stay in the VM vault. An agent cell gets the sockets of its agent's own connectors only, and the agent can invoke only their structured operations, as Anchi tools (`gmail_list`, `notion_create_page`, …).

## Account setup

| Connector | Preparation | Connect |
|---|---|---|
| Gmail | Without a built-in client: enable Gmail API in Google Cloud and import a Desktop OAuth client JSON | `scripts/anchi setup google-client <json>` once, then `scripts/anchi setup service gmail [--account <name>]` (read-only scope) |
| Google Drive | Enable Drive API in the same project; add `drive.readonly` and `drive.file` to the consent configuration | `scripts/anchi setup service drive [--account <name>]`; tokens are stored independently from Gmail |
| Notion | As workspace Owner, open [developer connections](https://app.notion.com/developers/connections), create an Internal connection, enable read/insert/update content under Configuration, copy its Installation access token, and share a test page through Content access or the page's Connections menu | `scripts/anchi setup service notion`, then enter the `ntn_` token without echo |
| Slack | Create an app at api.slack.com; add `channels:read`, `channels:history`, `groups:read`, `groups:history`, `chat:write`; install it and invite the bot to the intended channels | `scripts/anchi setup service slack`, then enter the `xoxb-` Bot User OAuth Token |

The TUI's **Connectors → Services** does the same with masked input in a full-screen dialog that agent output cannot draw over. Tokens go from the client to the daemon and over stdin to the encrypted vault; they are never logged or stored on the Mac. After import, the connector's own identity probes `auth.test`, `users/me` or `about` for the account label. A failed probe affects label verification, not the stored token.

Gmail and Drive can hold several Google accounts each, by name (`default` without `--account`). An agent's file picks one per service with `accounts: { gmail: work, drive: personal }`; the bridge pins it to the agent's cells, and grants bind to that account's generation. The client and the choice between Anchi's built-in client and your own are described in [Gmail setup](GMAIL_SETUP.md#1-prepare-google-oauth).

## Authorization modes

New connections use **standing authorization** (`auto`): allowlisted reads and writes receive one-time policy grants automatically. Switch to **per-request approval** (`ask`) to review each operation in Anchi's approval dialog. Any mode change revokes all unconsumed grants. The mode is per connector service and applies to every agent. An agent can additionally have its writes held with `approvals: {notion: ask}` in its file (the policy principal `notion:<agent>`): agents reach the services through a bridge that names them, so policy can tell them apart.

```bash
scripts/anchi setup service-mode drive ask   # Require approval for Drive
bash scripts/policy.sh rules                 # Show current modes
```

Older databases without a mode use `auto`; explicit modes are preserved. The old read-only permission is not equivalent to standing read/write authorization. Review modes after upgrading, especially when handling untrusted content.

## Available operations

| Connector | Reads | Writes |
|---|---|---|
| Drive | `drive_search`: name/full text, up to 10 results; `drive_read`: exported Google Docs text or text files, up to 40 KB | `drive_create`: text or Google Docs in a folder; `drive_update`: app-created text files with a current revision, optional strong ETag; Google Docs overwrite is unsupported |
| Notion | `notion_search`: up to 10 results; `notion_read`: page blocks as text, up to 40 KB | `notion_create_page`: child page; `notion_append`: paragraphs bound to current edit time |
| Slack | `slack_channels`: joined channels; `slack_history`: up to 50 messages | `slack_post`: message, optionally in a thread |
| Gmail | Status, list and read; see [Gmail setup](GMAIL_SETUP.md) | None |

Write bodies are limited to 48 KB and each connector to 200 writes per day. Updates bind to the target revision in either mode. Agents see tools only for the connectors bound into their cell.

## Reviewing writes in approval mode

The approval dialog shows the agent, task, operation and the parameters the policy service recorded. Approval authorizes one execution of exactly that content. Updates recheck the target immediately before execution; changes fail with `TARGET_CHANGED` without retry.

The in-cell tool keeps the same request ID while waiting and times out after ten minutes. Prepared actions are persisted; retries do not freeze a newer target version. Successful requests return cached results. Timeouts, dropped connections, upstream 5xx or unparseable success responses are recorded as UNKNOWN and are not automatically replayed. Check the remote service before taking further action.

## Disconnecting

- Gmail/Drive: revoke local access, remove tokens and attempt Google revocation, per account (`--account <name>`, `default` otherwise). Failed remote revocation is shown as pending retry.
- Slack: revoke local access, call `auth.revoke`, then remove the token.
- Notion: revoke local access and remove the token. No remote revoke API is available; remove the integration in Notion settings yourself.

## Data handling and limits

- Read mail, files, pages and messages may enter agent context and cloud models. Credential isolation does not keep all content local.
- Drive's `drive.file` scope limits updates to app-created files; other updates fail with `TARGET_NOT_WRITABLE`.
- Drive requires a nonempty revision and rechecks it. A strong ETag, when supplied upstream, is sent with `If-Match`; HTTP 412 maps to `TARGET_CHANGED`. Without an ETag the precheck is not an atomic conditional write. Google Docs overwrite is refused because the required revision field is absent; reading and creation remain available.
- Notion's edit-time check also has a race between checking and appending.
- Notion traverses nested blocks with at most five child-pagination requests, depth eight and 40 KB. Incomplete text is marked `truncated`; images and other nontext omissions are reported separately in `omissions`.
- Slack history is bounded by total serialized UTF-8 size. More upstream content or a size limit produces `truncated`; use `next_cursor` where available.
- Slack supports only joined channels, not direct messages, user tokens or OAuth. Notion uses API version `2022-06-28`.

## CLI and validation

```bash
bash scripts/policy.sh read drive allow  # Compatibility alias: allow=auto (includes writes), deny=ask
bash scripts/policy.sh pending
limactl shell secure-vm -- sudo /usr/bin/python3 /opt/secure-vm/services/connector_admin.py slack probe
```

Real-account validation remains a maintainer task: connect, search, read, create, update/append/post, inspect and approve full write content in `ask` mode, then disconnect. Local tests do not replace provider-specific account checks.
