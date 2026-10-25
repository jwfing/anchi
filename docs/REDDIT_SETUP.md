# Connect Reddit

Anchi's `reddit` connector browses subreddits, searches and reads posts, reads comments,
and publishes text posts or replies after approval. One Reddit account is connected at a
time. Tokens stay in the VM vault; agents receive tools through their own connector bridge.

## Connect your account

1. Obtain approved Reddit Data API access for your use case. Creating an app or signing into
   Reddit alone does not grant API access. Follow Reddit's
   [access instructions](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data).
   This connector uses the Data API, not the Reddit-hosted Devvit platform.
2. Use an **installed app** (public OAuth client), registered with this exact redirect URI:
   `http://127.0.0.1:48174/callback`. Anchi needs the Client ID and the app developer's Reddit
   username for its identifying User-Agent. Web/script clients with a secret and password
   authentication are not supported.
3. Update Anchi and run `anchi setup install` to install the Reddit service and cell tools.
   Restart the host daemon (`anchi daemon stop`, then open Anchi). Unlock the vault if needed.
4. In **Connectors**, select **reddit** and press **Enter**. Enter the Client ID and developer
   username, without `u/`, then authorize in your browser. The CLI does the same:

   ```bash
   anchi setup reddit-client <client-id> <developer-username>
   anchi setup service reddit
   ```

Anchi uses Reddit's [installed-app authorization-code flow](https://github.com/reddit-archive/reddit/wiki/OAuth2)
with a one-time state and `duration=permanent`, requesting exactly `identity`, `read`, and
`submit`. The documented flow does not use PKCE. The host receives only the loopback code;
token exchange and refresh run in the VM. Account verification with `/api/v1/me` must succeed
before the connection is stored. The callback port must be free. A failed sign-in leaves an
existing connection intact; reauthorize if Reddit invalidates its refresh token.

## Give an agent access

Enable **reddit** in the agent settings panel (**^X s**), or include it in the agent file:

```yaml
runtime: codex
connectors: [reddit]
approvals: { reddit: ask }
prompt:
  text: |
    Read a small set of relevant posts and draft a response in conversation.
    Respect each subreddit's rules. Publish only the draft I choose.
    Never repeat a write whose outcome is unknown.
```

| Tool | Parameters | Result |
|---|---|---|
| `reddit_list` | `subreddit`, `limit` (1–25), optional `sort` (`hot`, `new`, `top`) and `cursor` | Subreddit posts; default sort is `hot` |
| `reddit_search` | `query`, `limit` (1–25), optional `subreddit` and `cursor` | Matching posts, sorted by relevance |
| `reddit_read` | `id` | One post (`t3_…`) or comment (`t1_…`) |
| `reddit_comments` | `post_id` (`t3_…`), `limit` (1–25) | A bounded, flattened comment tree with parent ids |
| `reddit_submit` | `subreddit`, `title`, `text` | After approval (or at once in `auto`): a text post id and URL |
| `reddit_comment` | `parent` (`t3_…` or `t1_…`), `text` | After approval (or at once in `auto`): the new comment id |

Use subreddit names without `r/`. Read tools return `items`, `next_cursor`, `truncated`, and
`untrusted_content`. Comments request depth three and do not expand Reddit's `more` entries;
omissions are marked. Listing/search cursors are available only when Anchi has not clipped
the response. Text fields are bounded and each result stays below the bridge's byte limit.

Drafts remain conversation text. **Reddit posts and comments ask for approval by default**,
including in scheduled tasks and for agents without an `approvals` entry. The review shows the
verified account, destination subreddit and title or parent id, and full text. Approval binds to
that exact content and connection generation. Open the full approval dialog (**a** in Approvals or
**^X a**); use **↑/↓**, **PgUp/PgDn**, or **Home/End** to review long text. Reads run automatically.

`anchi setup service-mode reddit auto` lets every agent post and comment without approval, and
`approvals: {reddit: auto}` in an agent file does it for that agent only; `approvals: {reddit: ask}`
keeps an agent asking. In `auto`, an agent publishes under your account without a person, also in
tasks a trigger starts and that read untrusted content, so instructions in that content can make
it post. The TUI asks you to confirm before it sets `auto`, and the CLI prints this warning. The
policy service in the VM learns the new rule with `anchi setup install`.

## Limits and recovery

- Titles are at most 300 characters; post/comment bodies are at most 10,000 characters.
  This version supports text self posts and comments only. Link/media posts, flair selection,
  edits, deletion, votes, messages, subscriptions and moderation operations are not exposed.
  Communities that require flair or other unsupported submission fields can reject a post.
- The common connector throttle allows 60 requests per minute. The persistent write ledger
  reserves at most 200 writes per rolling 24 hours across all agents. Reddit can apply stricter
  limits, account restrictions and community rules; rejected writes are reported without
  reflecting private provider messages. A successful API submission can still await moderation.
- An HTTP 200 response containing Reddit API errors is a rejection, not a successful post.
  Unknown outcomes, such as timeouts, malformed success responses or upstream 5xx, are not
  automatically retried. Check Reddit before attempting a new publication. Retries of a known
  successful request return its recorded result; reconnecting invalidates pending old requests.
- Disconnect with `anchi setup disconnect reddit` or **d** on the connector. Local tokens are
  removed first, then remote revocation is attempted. If revocation remains pending, disconnect
  again to retry or revoke the app in Reddit preferences. Client configuration remains stored;
  finish revocation before replacing it with **Shift+R** in Connectors or `reddit-client`.
- Read content enters task histories and may enter the runtime's model context. Anchi does not
  automatically synchronize Reddit deletions into saved task histories or model sessions.
  Account for these copies when meeting your approved use case's retention requirements; see
  the [Data API guidance](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).

Offline tests exercise OAuth, credential separation, input bounds, approval binding and replay
protection. Real-account authorization, publishing, moderation and API eligibility still need
provider-side validation. Live VM isolation checks run separately when explicitly requested.
