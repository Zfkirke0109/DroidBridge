# DroidBridge Claude connector relay

A small Cloudflare Worker + Durable Object that you deploy to **your own** Cloudflare account. It
gives Claude (web, desktop and the mobile apps, which share account-level custom connectors) a
public HTTPS MCP endpoint, and it lets DroidBridge on your phone answer it over an outbound long
poll. The phone never opens a port. The design is in [DESIGN.md](DESIGN.md).

## Prerequisites

- A Cloudflare account. The Workers free plan is enough (see [Costs](#costs)).
- Node.js 22 or newer, for Wrangler and the key script (Wrangler 4 refuses to run on older
  versions). Nothing gets installed into this folder: the relay has no npm dependencies.
- A DroidBridge phone build with the `droidbridge-relay/1` device client. The 0.5.1 source on this
  branch does not include the Claude connector yet; deploying the Worker alone cannot connect the
  phone to Claude.

## Deploy

Run these commands in this `relay/` folder.

1. Sign in to Cloudflare:

   ```sh
   npx wrangler@4 login
   ```

2. Deploy:

   ```sh
   npx wrangler@4 deploy
   ```

   Note the URL Wrangler prints, `https://droidbridge-relay.<your-account>.workers.dev`. This is
   your **relay URL**.

3. Create a device key:

   ```sh
   node scripts/new-device-key.mjs
   ```

   It prints a device key (`dbrk_` followed by 43 characters) and its SHA-256. Keep the key for
   the app. Only the hash goes to Cloudflare.

4. Store the hash as a secret, pasting the hash when Wrangler asks for it:

   ```sh
   npx wrangler@4 secret put DEVICE_KEY_SHA256
   ```

   Until this secret is set, device routes answer `503 {"error":"relay_not_configured"}` and
   Claude's requests are answered as "offline".

You can check the relay with `curl https://<relay>/` (it answers `DroidBridge relay`) and
`curl https://<relay>/.well-known/oauth-protected-resource`.

## Connect DroidBridge

In a phone build with the Claude relay client, open **Agent connection → Claude connector**, enter
the relay URL and the device key, and turn the connector on. The phone then keeps one long poll open
to the relay. In the root edition, configure it through DroidBridge Root; the root backend must
maintain the poll independently of that settings app.

## Connect Claude

1. In Claude, open **Settings → Connectors → Add custom connector** and enter
   `https://<relay>/mcp`.
2. Select **Connect**. Your browser opens the relay's consent page, which names the client and
   where it returns to, and asks for a pairing code.
3. In DroidBridge, tap **Pair Claude**. The app shows a code like `K7QM-2XPA` for up to
   10 minutes. Type it into the consent page (case, dash and spaces do not matter; `O`, `I` and `L`
   are read as `0`, `1` and `1`) and select **Allow**.
4. Claude receives its OAuth tokens and the connector is ready.

The pairing code works once. A consent page accepts at most 3 failed tries before you have to
start connecting again from Claude, and after 5 wrong entries in all the code is cancelled and you
tap **Pair Claude** again. A wrong code and a missing or expired one get the same message, so the
page never reveals whether a pairing code is active. Only allow a consent page that you opened
yourself by connecting Claude: whoever started the flow receives the access.

## Revoke access

- **Disconnect Claude** in DroidBridge calls `POST /device/v1/revoke`. The relay deletes every
  access and refresh token, authorization code, waiting consent request, registered client,
  cached client document and the pairing code. Claude has to connect again (with a new pairing
  code) to regain access.
- **Rotate the device key**: run `node scripts/new-device-key.mjs` again, store the new hash with
  `npx wrangler@4 secret put DEVICE_KEY_SHA256`, and enter the new key in DroidBridge. The old key
  stops working once the new secret is deployed. This changes the phone's credential; it does not
  revoke Claude's tokens, so use **Disconnect Claude** for that.

## Configuration

`wrangler.toml` holds these variables:

| Variable | Default | Meaning |
|---|---|---|
| `RESPONSE_TIMEOUT_SECONDS` | `240` | How long the phone may take to answer one request, in seconds. Any number is rounded and clamped to 10..900; a value that is not a number means 240. |
| `CIMD_ALLOWED_HOSTS` | `claude.ai,claude.com` | Hosts whose client ID metadata documents the relay will fetch. Empty disables URL client IDs. |
| `EXTRA_REDIRECT_URIS` | empty | Extra exact OAuth redirect URIs to allow, comma separated: https, or http on `localhost` or `127.0.0.1`. The host must be a DNS name or IPv4 address, not an IPv6 literal such as `[::1]`, because the consent page's Content-Security-Policy cannot name one. Other entries are ignored. |
| `PUBLIC_ORIGIN` | empty | The public origin, such as `https://relay.example.com`. Empty means the origin each request arrived on. |
| `DEVICE_KEY_SHA256` | (secret) | SHA-256 of the device key, 64 lowercase hex. Set with `wrangler secret put`, never in the file. |

Tokens are bound to `<origin>/mcp`. If you add a custom domain, set `PUBLIC_ORIGIN` to it, so the
relay does not issue tokens for one hostname that the other rejects.

`wrangler.toml` also sets the `enable_request_signal` compatibility flag. Keep it: without it
Cloudflare never tells the relay that Claude or the phone disconnected, so a request Claude gave
up on could still reach the phone, and a phone poll whose connection dropped would still be
handed requests until it timed out (up to 25 seconds; those requests end as outcome unknown),
and the phone would count as online for 5 seconds after that, up to 30 seconds in all.

## Security notes

**What the relay can see.** It authenticates both sides and moves JSON-RPC bodies, so it sees the
content of every MCP request and response passing through it (tool calls and their results) while
they are in flight. It does not store them and does not log them. It never sees the Local MCP
token or any OpenAI key. It passes each message on as the exact text it received, never
re-encoded, so nothing in it changes: 64-bit integers such as inode numbers, nanosecond
timestamps or large ids arrive digit for digit. The one exception is a leading UTF-8 byte order
mark on Claude's request, which the relay removes (DroidBridge could not read it); every byte
after it is forwarded unchanged. That exactness ends at the relay: DroidBridge on the phone
parses each request and encodes it again before running it, which drops whitespace, sorts members
by name, can rewrite how some numbers and escapes are written (`1e15` becomes
`1000000000000000.0`) and can make the request longer.

**What it stores.** Only SHA-256 hashes of access tokens, refresh tokens, authorization codes,
consent request IDs, the pairing code and the device key. It also stores registered client
metadata, cached client ID metadata documents (used for at most 1 hour), and pending consent
requests (usable for 10 minutes). Expired records are deleted by a sweep that runs at most once a
minute, when Claude connects or refreshes its token and when DroidBridge polls, so while
DroidBridge is connected they are gone within about a minute and a half of expiring. With no
traffic at all they stay until the next request.

**What it forwards.** Claude's `Authorization` header, cookies and `Mcp-Session-Id` never reach the
phone. Only `Content-Type`, `Accept`, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` are
forwarded. Claude never sees the device key.

**OAuth.** OAuth 2.1 with PKCE (S256 only) and RFC 8707 resource binding. Access tokens
(`dbra_…`) last 1 hour and refresh tokens (`dbrr_<grant id>.<secret>`) 30 days. Refresh tokens
rotate on every use; presenting any rotated refresh token, however old and whatever client ID or
scope comes with it, revokes the whole grant while that grant is live (each refresh token names
its grant, so this holds even after the relay has deleted the old token's record; once a grant
has expired none of its tokens works anyway), and so does presenting an authorization code a
second time, however late and whatever client ID, redirect URI or code verifier comes with it
(the relay keeps a redeemed code's hash for as long as the grant it started exists). Both need a
well-formed token request (form-encoded, at most 16 KiB, no parameter repeated); a malformed one
is refused before the token or code in it is looked at, and revokes nothing.
Redirects go only to Claude's callbacks, Claude Code's loopback `http://localhost:<port>/callback`
or `http://127.0.0.1:<port>/callback`, or URIs you list in `EXTRA_REDIRECT_URIS`. An unknown
client or redirect URI gets an error page and is never redirected to. The consent page sends a
strict Content-Security-Policy and cannot be framed.

**The relay never queues or replays a request.** Each Claude request ends in exactly one of these
outcomes:

- **Offline**: no phone poll is waiting and none ended in the last 5 seconds. Claude gets HTTP 503
  at once, and the request was not delivered.
- **Unavailable**: the phone was online but did not poll again within 5 seconds. Claude gets HTTP
  503, the request is dropped, and no later poll can receive it.
- **Busy**: 16 requests are already in flight. Claude gets HTTP 429, and the request was not
  delivered.
- **Answered**: the phone posted its result in time, and Claude gets it with the phone's status
  code, except that 401, 407, 408, 413, 421, 425, 429 and every 5xx become HTTP 200: the phone
  has the request and may have run it, so Claude never gets a status after which an HTTP client
  might send it again on its own (an MCP client answers a 401 by refreshing its token and
  resending), or the 413 that means "refused before delivery". A request still gets the phone's
  JSON-RPC response as the body; a notification gets an empty 200. (The phone answers 413 when
  its own re-encoding made a request longer than 256 KiB.)
- **Invalid reply**: the phone's reply cannot be passed on: its status code is not an integer
  from 200 to 599, or, for a request, it is not a JSON-RPC response carrying the request's id
  (missing, not a JSON object, another id, not exactly one of `result` and `error`, or a status
  such as 204 that cannot carry a body). A request gets HTTP 200 with a JSON-RPC error (code
  `-32603`) saying it may or may not have run and was not retried; a notification gets an empty
  HTTP 200. A reply the relay cannot read at all (too large, not JSON, no `request_id`) ends its
  request this way at once, found by its shard token.
- **Outcome unknown**: the request was handed to the phone, but no result arrived within
  `RESPONSE_TIMEOUT_SECONDS` plus 5 seconds. Claude gets HTTP 200 with a JSON-RPC error (code
  `-32002`) saying the request may or may not have run and was not retried. HTTP 200 keeps
  HTTP-level clients from retrying it. A late result from the phone is discarded.

A request counts as handed to the phone the moment it is placed into a poll response. If the
phone's connection drops at that moment, the outcome is unknown, never "retried". A request Claude
gives up on before a poll takes it is dropped and never reaches the phone. If the relay itself
fails while handling a request (a storage error, a bug, the Durable Object being reset), Claude
also gets HTTP 200 with a JSON-RPC `-32002` error, never a 5xx; a notification gets an empty HTTP
200. The error's `delivered` field says what is known: `false` means the request never reached
the phone (one still waiting for a poll is withdrawn, so it cannot arrive later), `true` means it
was handed to the phone and may or may not have run, and `null` means the Worker could not tell
because the Durable Object itself failed (including an answer that broke off while the Worker was
reading it). Whether to send the request again is left to you or the model.

If the relay fails while building a poll response, none of the requests it would have carried
count as handed over. Requests that were waiting for a poll keep waiting for the next one, or end
as unavailable. A request that was about to go straight to a poll already waiting gets the
relay-failure answer with `delivered: false`, and that poll keeps waiting.

Requests in flight live only in the Durable Object's memory. If Cloudflare restarts the object,
those requests fail and are not replayed. OAuth state lives in the object's storage and survives.

**Limits.** MCP request bodies up to 256 KiB, nested at most 64 levels deep, with no unpaired
UTF-16 surrogate escape (such as a cut emoji `\ud83d`) in any string and no number that JavaScript
reads, rounded to the nearest double, as a magnitude above 1.79 × 10^308 or as infinity (such as
`1e400` or `1.795e308`; the phone refuses a number beyond the double range and can overflow on one
just below the largest double, about 1.7977 × 10^308). The phone could not read anything else, and
would drop every other request sent in the same poll response with it, so the relay refuses it
with HTTP 400 or 413 before delivery. A request's `id` is a string or an integer from -2^63 to
2^64 - 1 written without fraction or exponent, as the phone requires (400 otherwise), and a
message with a `result` or `error` member besides its `method` is refused with 400 too
(DroidBridge would refuse it without running it). Phone responses up to 13,048,576 bytes (the
phone's 12,000,000-byte MCP response limit plus 1 MiB of envelope; a larger reply is refused and
Claude gets the invalid-reply error at once), 20 client registrations per hour, 100 registered
clients, 50 waiting consent requests (10 per client).

## Costs

The phone keeps a long poll open, so the Durable Object stays active around the clock. Cloudflare
bills Durable Object duration at 128 MB per active object: about 10,800 GB-s per day, which is
inside the Workers free plan's 13,000 GB-s per day. Each poll is one request, about 6,000 per day
with DroidBridge's 15-second polls, against the free plan's 100,000 requests per day. Check
Cloudflare's current pricing page for the numbers that apply to your account.

## Development

```sh
node --test          # or: npm test
```

The tests use Node's built-in test runner, an in-memory storage and a fake clock, and run in a
couple of seconds. The code uses only Web-standard APIs, so the same modules run in Workers and in
Node 22.
