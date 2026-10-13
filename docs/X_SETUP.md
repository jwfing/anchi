# Connect X

Anchi's `x` connector reads posts, searches recent posts, reads mentions of the connected
account and publishes text posts or replies after approval. One X account is connected at a
time. Access and refresh tokens stay in the VM vault; agents receive structured tools through
their own connector bridge, without a token or browser session.

## Connect your account

1. Update Anchi, run `anchi setup install` to install the X service and cell tools, then restart
   the host daemon (`anchi daemon stop`, then open Anchi). Unlock the vault if needed.
2. Create an app in the [X Developer Console](https://console.x.com/). Enable OAuth 2.0 and
   choose **Native App** (a public client). Register this callback URL exactly:
   `http://127.0.0.1:48173/callback`. Anchi needs the OAuth **Client ID**, not an API key, app-only
   bearer token or client secret. Confidential Web App/bot clients are not supported.
3. Configure API credits and a spending limit in the X Developer Console. Reads and writes
   are billed by X; [current prices and billing limits](https://docs.x.com/x-api/getting-started/pricing)
   apply independently of Anchi.
4. In **Connectors**, select **x** and press **Enter**. Paste the Client ID when prompted,
   then authorize in the browser. The CLI does the same:

   ```bash
   anchi setup x-client <client-id>
   anchi setup service x
   ```

Anchi requests exactly `tweet.read`, `tweet.write`, `users.read` and `offline.access` using
[OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).
The host handles only the loopback authorization code; token exchange, account verification
and refresh happen in the VM. Anchi verifies the account with `/2/users/me` before saving it.
The callback port must be free; only one sign-in can use it at a time. A browser error or a
failed exchange leaves an existing connection intact. Reconnect if X revokes the refresh token.

## Give an agent access

Use the agent's settings panel (**^X s**) to enable **x**, or include it in the agent file:

```yaml
runtime: codex
connectors: [x]
approvals: { x: ask }
prompt:
  text: |
    Read mentions and draft concise responses in conversation.
    Publish only the draft I choose. Do not repeat a post with an unknown result.
```

The connector tools are:

| Tool | Parameters | Result |
|---|---|---|
| `x_read` | `id` | One post, its author id and URL |
| `x_search` | `query`, `limit` (10–25), optional `cursor` | Recent search results; use `next_cursor` for another page |
| `x_mentions` | `limit` (10–25), optional `cursor` | Mentions of the authenticated account |
| `x_post` | `text`, optional `reply_to` post id | After approval: published post id and URL |

Drafts are ordinary conversation text. Ask for revisions before calling `x_post`. The approval
view shows the posting account's handle and id, the full text and any reply target id. Approval
binds to that exact content and account generation. **X publishing always requires approval**,
including scheduled tasks; `approvals: {x: auto}` and `service-mode x auto` are refused. Reads
are automatic. Unanswered approvals expire after ten minutes.

Successful retries with the same request id return the recorded result. An uncertain result
(for example a timeout or upstream 5xx) is not retried automatically; check X before deciding
whether to publish again. A reconnect invalidates a write prepared for the old connection.

For a daily digest, use an ordinary agent `triggers` schedule that asks for a small `x_search`
or `x_mentions` result set and a draft. There is no X webhook or dedicated polling trigger.

## Limits and disconnect

- Recent search covers the API's recent window (currently seven days). Anchi returns up to
  25 posts per request, bounds post text and total response bytes, and labels read content as
  untrusted. `truncated` indicates omissions; a size-truncated page has no continuation cursor.
- All agents together can request up to 1,000 post resources per UTC day. Reservations count
  the requested page size, including failed requests; restarts and reconnects do not reset them.
  The service also has the common 60-request-per-minute throttle. These are request limits,
  not a monetary spending cap; set the monetary limit at X.
- The shared connector write ledger reserves at most 200 writes in a rolling 24-hour window.
  Posts have at most 280 Unicode characters at Anchi's boundary; X additionally enforces its
  own weighted character and account limits. No media, quotes, likes, follows, DMs or deletion
  operations are exposed.
- X restricts self-serve API replies to posts whose author has summoned the replying account
  by mentioning it or quoting one of its posts. X makes the final eligibility decision.
  See [Manage Posts](https://docs.x.com/x-api/posts/manage-tweets/introduction).
- Disconnect with `anchi setup disconnect x` or **d** on the X connector. Local access is
  removed first, then Anchi attempts remote revocation. If that fails, the UI shows revocation
  pending; disconnect again to retry, or revoke the app in X's Connected apps settings.
  The Client ID remains stored. Finish revocation before changing it (**x** in Connectors or
  `anchi setup x-client <client-id>`).

Offline tests cover OAuth and connector refusal paths, approval binding, refresh, quotas and
write replay protection. Real-account OAuth, publishing/reply eligibility and platform billing
still need provider-side validation; offline tests do not establish that an app has X API access.
