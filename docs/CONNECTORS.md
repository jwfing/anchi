# Account connectors

Gmail, Google Drive, Notion and Slack are registered in `services/connectors.py`. Each has its own UID, socket and egress identity. Connecting grants standing authorization by default; each connector can switch to per-request approval. Credentials stay in the VM vault, and the cell agent can invoke only structured operations.

## Account setup

| Connector | Preparation | Desktop action |
|---|---|---|
| Gmail | Enable Gmail API in Google Cloud; import a Desktop OAuth client JSON | Connect Google with the read-only scope |
| Google Drive | Enable Drive API in the same project; add `drive.readonly` and `drive.file` to the consent configuration | Connect Google separately; tokens are stored independently from Gmail |
| Notion | As workspace Owner, open [developer connections](https://app.notion.com/developers/connections), create an Internal connection, enable read/insert/update content under Configuration, copy its Installation access token, and share a test page through Content access or the page's Connections menu | Enter the `ntn_` token in the separate Notion token window |
| Slack | Create an app at api.slack.com; add `channels:read`, `channels:history`, `groups:read`, `groups:history`, `chat:write`; install it and invite the bot to the intended channels | Enter the `xoxb-` Bot User OAuth Token |

The token window is a separate main-process-created modal with a password field. Tokens go through IPC to the main process and stdin to the encrypted vault, never through the page displaying agent content or the activity log. After import, the connector's own identity probes `auth.test`, `users/me` or `about` for the account label. A failed probe affects label verification, not the stored token.

## Authorization modes

New connections use **standing authorization** (`auto`): allowlisted reads and writes receive one-time policy grants automatically. Switch to **per-request approval** (`ask`) to review each operation on Independent approval. Restoring standing authorization requires confirmation of prompt-injection risk. Model calls have the same control in setup section 4. Any mode change revokes all unconsumed grants.

```bash
bash scripts/policy.sh rules                 # Show current modes
bash scripts/policy.sh mode drive ask        # Require approval for Drive
bash scripts/policy.sh mode inference auto   # Restore automatic model authorization
```

Older databases without a mode use `auto`; explicit modes are preserved. The old read-only permission is not equivalent to standing read/write authorization. Review modes after upgrading, especially when handling untrusted content.

## Available operations

| Connector | Reads | Writes |
|---|---|---|
| Drive | `drive_search`: name/full text, up to 10 results; `drive_read`: exported Google Docs text or text files, up to 40 KB | `drive_create`: text or Google Docs in a folder; `drive_update`: app-created text files with a current revision, optional strong ETag; Google Docs overwrite is unsupported |
| Notion | `notion_search`: up to 10 results; `notion_read`: page blocks as text, up to 40 KB | `notion_create_page`: child page; `notion_append`: paragraphs bound to current edit time |
| Slack | `slack_channels`: joined channels; `slack_history`: up to 50 messages | `slack_post`: message, optionally in a thread |
| Gmail | Status, list and read; see [Gmail setup](GMAIL_SETUP.md) | None |

Write bodies are limited to 48 KB and each connector to 200 writes per day. Updates bind to the target revision in either mode. Pi registers tools only for connected connectors when creating a session.

## Reviewing writes in approval mode

Write approvals have a prominent banner, account, operation, target (file/revision, page/edit time, or channel/thread) and full body. Approval authorizes one execution. Updates recheck the target immediately before execution; changes fail with `TARGET_CHANGED` without retry.

Pi retains the same request ID while waiting, supports cancellation and times out after ten minutes. Prepared actions are persisted; retries do not freeze a newer target version. Successful requests return cached results. Timeouts, dropped connections, upstream 5xx or unparseable success responses are recorded as UNKNOWN and are not automatically replayed. Check the remote service before taking further action.

## Disconnecting

- Gmail/Drive: revoke local access, remove tokens and attempt Google revocation. Failed remote revocation is shown as pending retry.
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
