# Connectors

Anchi has two kinds of connectors. Each section below says where to get the credential, what to grant and how to enter it. The desktop app links each connector in **Settings** to its section here.

- **Token connectors** (GitHub, AWS, Linear, PostHog, Sentry, Firecrawl, Figma, Discord): the egress proxy adds the credential to the agent's requests to that service's API. Agents see a placeholder.
- **Account connectors** (Gmail, Google Drive, Notion, Slack, X, Reddit): trusted services in the VM act for agents through structured Anchi tools.

## Token connectors

Enter a token in the desktop app's **Settings → Connectors** (**Connect** on the row), the TUI's **Connectors**, or with `anchi setup connector <name>`, which prompts without echo. Anchi checks the credential with the service and shows the account it belongs to; a credential the service refuses is not kept. Grant only what agents need: any call the proxy permits acts with the full authority of the credential.

### GitHub

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) (GitHub → Settings → Developer settings → Personal access tokens). Limit it to the repositories the agents work on, with contents, pull requests and issues read/write. For an organization's private repositories, choose the organization as the token's resource owner; the organization may also have to approve the token. `anchi setup connector github --from-gh` imports the token of the `gh` CLI instead, which usually has broader scopes.

### AWS

Use a dedicated IAM principal whose policy allows only what agents should do, for example `logs:FilterLogEvents` on specific log groups, and create its access keys in the [IAM console](https://console.aws.amazon.com/iam/). AWS is entered from the CLI or the TUI, not the desktop app: `anchi setup connector aws` asks for the keys and a region, and `anchi setup connector aws --profile <name>` uses a profile on this computer, such as AWS SSO, and refreshes its temporary credentials. See [Agent team](AGENT_TEAM.md) for the profile mode.

### Linear

Create a personal API key (`lin_api_…`) under Linear → Settings → Security & access → Personal API keys. Choose only the teams and permissions the agents need. Workspace admins can turn off API key creation for members.

### PostHog

Create a personal API key (`phx_…`) under PostHog → Settings → [Personal API keys](https://us.posthog.com/settings/user-api-keys) ([EU Cloud](https://eu.posthog.com/settings/user-api-keys)). Give it only the scopes the agents need, for example `query:read` and `insight:read`, and only their projects. US and EU Cloud are supported; self-hosted PostHog is not. The import tries the US first, then the EU, and the account label says which.

### Sentry

Create a user auth token (`sntryu_…`) under Sentry → User settings → [Personal Tokens](https://sentry.io/settings/account/api/auth-tokens/), with the scopes the agents need, for example `org:read`, `project:read` and `event:read`. Organization tokens (`sntrys_`) cannot read the API and are refused. `sentry.io` and its `us.` and `de.` region hosts are supported; self-hosted Sentry is not.

### Firecrawl

Copy an API key (`fc-…`) from the [Firecrawl dashboard](https://www.firecrawl.dev/app/api-keys). Firecrawl fetches any URL on the agent's behalf, so it reaches pages beyond the agent's `egress` list, and a URL it is asked to fetch can carry data out. Grant it only to agents that should read the web freely.

### Figma

Create a personal access token (`figd_…`) under Figma → Settings → Security → Personal access tokens, with read scopes, plus `file_comments:write` if agents comment. Figma shows the token once. See Figma's [token guide](https://developers.figma.com/docs/rest-api/personal-access-tokens/).

### Discord

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), open **Bot** and reset the token to copy it. Invite the bot to the servers the agents work in, and turn on the Message Content intent if they read messages. Agents use the REST API (`https://discord.com/api/v10`). The gateway, a WebSocket that carries the token inside a message, does not work, so a bot cannot receive events in real time.

## Account setup

Gmail, Google Drive, Notion, Slack, X and Reddit are registered in `services/connectors.py`. Each has its own UID, socket and egress identity. Gmail, Drive, Notion and Slack grant standing authorization by default and can switch to per-request approval. X and Reddit read automatically and ask for approval to publish unless you set their writes to `auto`. Credentials stay in the VM vault. An agent cell gets the bridge sockets of its agent's own connectors only, and the agent can invoke only their structured operations, as Anchi tools (`gmail_list`, `notion_create_page`, `x_post`, …).

Gmail, Drive, X and Reddit sign in through the browser with an OAuth app you create first. The desktop app's **Sign in** needs that app's client imported with the command in its section; the desktop app cannot import it yet. Notion and Slack take a token, which the desktop app's **Connect** accepts.

### Gmail

Without a built-in client, enable Gmail API in Google Cloud and create a Desktop OAuth client; [Gmail setup](GMAIL_SETUP.md#1-prepare-google-oauth) has the steps. Import its JSON once with `anchi setup google-client <json>`, then sign in with **Sign in** or `anchi setup service gmail [--account <name>]` (read-only scope).

### Google Drive

Enable Drive API in the same Google Cloud project and add `drive.readonly` and `drive.file` to the consent configuration. Sign in with **Sign in** or `anchi setup service drive [--account <name>]`. Its tokens are stored independently from Gmail's.

### Notion

As workspace Owner, open [developer connections](https://app.notion.com/developers/connections), create an Internal connection, enable read/insert/update content under Configuration and copy its Installation access token (`ntn_…`). Share the pages agents should use through Content access or each page's Connections menu. Enter the token with **Connect** or `anchi setup service notion`.

### Slack

Create an app at [api.slack.com/apps](https://api.slack.com/apps). Under **OAuth & Permissions**, add the bot scopes `channels:read`, `channels:history`, `groups:read`, `groups:history` and `chat:write`, install the app to the workspace and copy the Bot User OAuth Token (`xoxb-…`). Invite the bot to each channel agents should use (`/invite @<bot>`). Enter the token with **Connect** or `anchi setup service slack`.

### Reddit

Reddit needs approved Data API access and an installed OAuth app; [Reddit setup](REDDIT_SETUP.md#connect-your-account) has the steps. Import the app with `anchi setup reddit-client <client-id> <developer-username>`, then sign in with **Sign in** or `anchi setup service reddit`.

### X

X needs a native OAuth 2.0 app with an exact loopback callback, and API credits; [X setup](X_SETUP.md#connect-your-account) has the steps. Import the app with `anchi setup x-client <client-id>`, then sign in with **Sign in** or `anchi setup service x`.

The TUI's **Connectors → Services** does the same with masked input in a full-screen dialog that agent output cannot draw over; **Tab** shows the input to check it and hides it again. The desktop app's **Settings → Services** takes the Notion or Slack token in a password field under the service's row (**Connect**). Tokens go from the client to the daemon and over stdin to the encrypted vault; they are never logged or stored on the Mac. After import, the connector's own identity probes `auth.test`, `users/me` or `about` for the account label. A failed probe affects label verification, not the stored token.

Gmail and Drive can hold several Google accounts each, by name (`default` without `--account`). An agent's file picks one per service with `accounts: { gmail: work, drive: personal }`; the bridge pins it to the agent's cells, and grants bind to that account's generation. The client and the choice between Anchi's built-in client and your own are described in [Gmail setup](GMAIL_SETUP.md#1-prepare-google-oauth).

## Missing connectors after an update

Closing and reopening the TUI keeps using the background daemon. If it started before the
update, it can still return the old connector list, even when both builds report the same
release version. Connectors names services missing from the daemon's response and shows the
restart instructions.

The list follows the selection and shows its position, so entries at the bottom remain visible
in small terminals. Press **↑/↓** or **j/k** in the main pane to reach X and Reddit.

After current tasks finish, run `anchi daemon stop`, then `anchi setup install` from the updated
installation and reopen Anchi. The install command starts the updated daemon and copies the
current connector services into the VM; agents, tasks and stored credentials are preserved.
From a source checkout, use `./scripts/anchi` in place of `anchi` for these commands. Confirm
that `anchi setup status` lists both `x` and `reddit` under Services. Their CLI identifiers are
`x` and `reddit`, rather than their website domain names.

## Authorization modes

X and Reddit differ from the other services in two ways. Their reads are always automatic, and
their writes default to per-request approval (`ask`) with an exact-content approval of each post.
`anchi setup service-mode x auto` (or `reddit`) lets every agent with that connector publish
under your account without a person; an agent's own `approvals: {x: auto}` does the same for that
agent only, even while the service asks. With `auto`, a task can post publicly, including a task
a trigger starts and that reads untrusted content (mentions, issues, mail, web pages): instructions
in that content can make the agent post. The TUI asks for confirmation before it sets `auto`, and
the CLI prints this warning. `approvals: {x: ask}` keeps an agent asking either way.

New connections use **standing authorization** (`auto`): allowlisted reads and writes receive one-time policy grants automatically. Switch to **per-request approval** (`ask`) to review each operation in Anchi's approval dialog. Any mode change revokes all unconsumed grants. The mode is per connector service and applies to every agent. An agent can additionally have its writes held with `approvals: {notion: ask}` in its file (the policy principal `notion:<agent>`): agents reach the services through a bridge that names them, so policy can tell them apart.

```bash
anchi setup service-mode drive ask   # Require approval for Drive
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
| Reddit | `reddit_list`, `reddit_search`, `reddit_read`, `reddit_comments`; at most 25 items per call | `reddit_submit`, `reddit_comment`: text posts/replies, always approved; see [Reddit limits](REDDIT_SETUP.md#limits-and-recovery) |
| X | `x_read`, `x_search`, `x_mentions`; at most 25 posts per page and 1,000 requested post resources per UTC day | `x_post`: text or reply, always approved; see [X limits](X_SETUP.md#limits-and-disconnect) |

Write bodies are limited to 48 KB and each connector to 200 writes per day. Updates bind to the target revision in either mode. Agents see tools only for the connectors bound into their cell.

## Reviewing writes in approval mode

The approval dialog shows the agent, task, operation and the parameters the policy service recorded. The list shows a preview; open the full dialog (**a** or **^X a**) and use **↑/↓**, **PgUp/PgDn**, or **Home/End** to review wrapped long text. Policy parameters are preserved in full, with an oversized action refused instead of truncated. Approval authorizes one execution of exactly that content. Updates recheck the target immediately before execution; changes fail with `TARGET_CHANGED` without retry.

The in-cell tool keeps the same request ID while waiting and times out after ten minutes. Prepared actions are persisted; retries do not freeze a newer target version. Successful requests return cached results. Timeouts, dropped connections, upstream 5xx or unparseable success responses are recorded as UNKNOWN and are not automatically replayed. Check the remote service before taking further action.

## Disconnecting

- X/Reddit: remove local access first and attempt remote revocation; retry disconnect while revocation is pending. The Client ID remains stored.
- Gmail/Drive: revoke local access, remove tokens and attempt Google revocation, per account (`--account <name>`, `default` otherwise). Failed remote revocation is shown as pending retry.
- Slack: revoke local access, call `auth.revoke`, then remove the token.
- Notion: revoke local access and remove the token. No remote revoke API is available; remove the integration in Notion settings yourself.

The desktop app's **Settings → Services** does the same with **Disconnect** (per account for Gmail and Drive, **Revoke again** while a revocation is pending), after a system dialog.

## Data handling and limits

- Read mail, files, pages and messages may enter agent context and cloud models. Credential isolation does not keep all content local.
- Drive's `drive.file` scope limits updates to app-created files; other updates fail with `TARGET_NOT_WRITABLE`.
- Drive requires a nonempty revision and rechecks it. A strong ETag, when supplied upstream, is sent with `If-Match`; HTTP 412 maps to `TARGET_CHANGED`. Without an ETag the precheck is not an atomic conditional write. Google Docs overwrite is refused because the required revision field is absent; reading and creation remain available.
- Notion's edit-time check also has a race between checking and appending.
- Notion traverses nested blocks with at most five child-pagination requests, depth eight and 40 KB. Incomplete text is marked `truncated`; images and other nontext omissions are reported separately in `omissions`.
- Slack history is bounded by total serialized UTF-8 size. More upstream content or a size limit produces `truncated`; use `next_cursor` where available.
- Slack supports only joined channels, not direct messages, user tokens or OAuth. Notion uses API version `2022-06-28`.

## CLI and validation

From a source checkout (`scripts/policy.sh` is not in the release archive; the TUI's approval dialog and `anchi approvals` cover the same decisions):

```bash
bash scripts/policy.sh read drive allow  # Compatibility alias: allow=auto (includes writes), deny=ask
bash scripts/policy.sh pending
limactl shell anchi-vm -- sudo /usr/bin/python3 /opt/secure-vm/services/connector_admin.py slack probe
```

Real-account validation remains a maintainer task: connect, search, read, create, update/append/post, inspect and approve full write content in `ask` mode, then disconnect. Local tests do not replace provider-specific account checks.
