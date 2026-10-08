# Claude connector relay: design

Status: accepted for the first implementation. Scope: let Claude (web, desktop, Android and iOS
apps, which all use the same account-level custom connectors) reach the DroidBridge MCP server on
a phone that has no public address.

## Context

Claude custom connectors are called from Anthropic's cloud, so the MCP endpoint must be a public
HTTPS URL. The phone must never expose `127.0.0.1:8765` (the Local MCP listener) or any other
port. The OpenAI tunnel already solves the same problem for ChatGPT with an outbound long-poll:
the phone polls a control plane, executes each command against the in-process MCP facade, and
posts the response back. Anthropic offers no such control plane, so DroidBridge ships a small
relay the user deploys to their own Cloudflare account.

## Decision

Three ingress providers, one MCP facade, separate credentials:

| Provider | Caller authenticates with | Phone side |
|---|---|---|
| Local MCP | Local MCP bearer token (on the phone only) | loopback listener |
| OpenAI tunnel | OpenAI tunnel API key (phone → `api.openai.com`) | long-poll client |
| Claude relay | OAuth 2.1 access token minted by the relay (Claude → relay); device key (phone → relay) | the same long-poll client, pointed at the relay |

No credential crosses a trust domain: the relay never sees the Local MCP token or the OpenAI key,
Claude never sees the device key, the phone never sees Claude's OAuth tokens (the relay strips
`Authorization` and forwards only an allowlist of MCP headers), and the device key is stored on
the phone encrypted under its own Android Keystore alias.

The relay is transport-only. It authenticates both sides, moves JSON-RPC bodies, and never
interprets, caches, queues for later, or retries an MCP request. It moves each message as the
text it received: Claude's request body goes into the poll response exactly as Claude sent it
(except that a leading UTF-8 byte order mark is removed when the body is decoded; every byte
after it is forwarded unchanged), and the phone's `resp_json` reaches Claude exactly as the phone
wrote it. The relay parses them only to check them and never re-encodes them, so no value
changes inside the relay: an integer above 2^53 (a 64-bit inode, a nanosecond timestamp, a
64-bit id), `-0` and every other number keep their digits, and escapes, whitespace and member
order stay as written.

Byte-exactness ends at the relay. The phone's tunnel client parses each command into a
serde_json `Value` and encodes it again before the MCP facade sees it, so the facade does not get
Claude's bytes: whitespace is dropped, members are sorted by name (a repeated member keeps its
last value), a number written with a fraction or an exponent, or an integer outside the i64/u64
range, is read as a double and written in serde_json's own form (`1e15` becomes
`1000000000000000.0`, `1.50` becomes `1.5`, digits beyond a double's precision are lost), `-0`
becomes `-0.0`, and string escapes are rewritten (`"A\/b"` becomes `"A/b"`). The message can
grow on the way. A re-encoded message over the facade's 262 144-byte limit is refused by the phone
with 413, which reaches Claude as HTTP 200 carrying the phone's JSON-RPC error (settlement
rule 7).

### Execution settlement rules

A JSON-RPC request (a message with an `id`) whose execution outcome is unknown is never answered
with a retryable 5xx. The relay's own 4xx and 5xx statuses are kept for answers that provably did
not deliver the request: the pre-delivery answers under "Claude side: MCP endpoint" and rules 1
and 2 below. Once a message has been delivered to the phone, Claude never gets a status after
which an HTTP client may send the request again on its own (401, 407, 408, 421, 425, 429 or any
5xx), nor 413, which Claude gets only for a body the relay refused before delivery (rule 7).
Every POST /mcp ends in exactly one of these outcomes, or in a valid reply from the phone (see
"Device protocol").

1. **Offline means not delivered.** A request that arrives while no phone poll is waiting (and no
   poll ended in the last 5 s) is answered at once with HTTP 503 and a JSON-RPC error whose
   `data.droidbridge_relay` is `{"state":"offline","delivered":false}`. Nothing is queued.
2. **Hand-off window.** If the phone is online but between polls, the request waits at most 5 s
   for the next poll. If none comes it is dropped from memory and answered like rule 1
   (`"state":"unavailable","delivered":false`). It can never be delivered later. The same
   happens at once when Claude gives up first: a request whose connection is aborted before a
   poll takes it (even one already aborted when it reaches the hand-off) is never delivered.
3. **Exactly one delivery.** A command is handed to exactly one poll response, then removed from
   the hand-off list. A later poll never sees it again. A command counts as delivered only
   together with the poll response body that carries it: each command is encoded when it is
   accepted (its fields, with the message text added as is), and a poll either takes its
   commands with every deadline armed, or fails (HTTP 500 to the phone) without marking any of
   them delivered, leaving them in the hand-off list (or the parked poll parked). A phone poll
   whose connection dropped, or was already gone when it reached the relay, stops counting as a
   waiting poll and is never handed a command.
4. **Unknown settlement is final.** If the phone does not post a response before the command's
   deadline (`response_timeout` + 5 s grace), the relay answers HTTP 200 with a JSON-RPC error
   (`code -32002`, `data.droidbridge_relay` = `{"state":"settlement_unknown","delivered":true,
   "retried":false}`) saying the request may or may not have run and was not retried. HTTP 200
   keeps HTTP-layer clients from replaying it. A late response for that request gets 404.
5. Notifications follow the same rules but get no JSON-RPC body.
6. **A relay failure is final too, never a 5xx.** Any failure while the relay handles POST /mcp
   (a storage error, a bug, the Durable Object being reset or unreachable) is answered HTTP 200
   with a JSON-RPC error (`code -32002`, `data.droidbridge_relay` =
   `{"state":"settlement_unknown","delivered":D,"retried":false}`, the request's `id` when its
   body can be read, else `null`); a notification gets an empty HTTP 200. `D` is what is
   actually known:
   - `false`: the failure came before the command was placed into a poll response, or the
     Worker could not address the Durable Object at all. A command still waiting in the
     hand-off list is withdrawn first, so it can never be delivered later.
   - `true`: the command had been placed into a poll response. The relay stops waiting for it,
     so a late reply from the phone gets 404.
   - `null`: the Worker cannot tell, because the Durable Object threw, answered with a 5xx it
     did not mark as its own, or its answer broke off before the Worker had read all of it (the
     Worker reads the whole answer before passing it on, so Claude never gets a truncated 200).

   The Durable Object marks every POST /mcp answer it makes on purpose with the internal header
   `X-DroidBridge-Relay-Answer`, which the Worker removes before the answer reaches Claude. The
   Worker passes a 5xx through only when it carries that mark, and the only 5xx the object
   answers on purpose is the not-delivered 503 of rules 1 and 2 (rule 7 turns a phone 5xx into
   HTTP 200). Any other 5xx on POST /mcp, and a failed call to the object, becomes the
   `D = null` answer above.
7. **After delivery, no replayable status.** A valid reply from the phone passes through with
   the phone's own status (the phone, not the relay, reports that outcome), except 401, 407,
   408, 413, 421, 425, 429 and 500 to 599. A request whose valid reply carries one of these is
   answered HTTP 200 with the phone's `resp_json` text unchanged; the reply is still checked as
   under "Device protocol", and an invalid one gets the HTTP 200 `-32603` answer. A
   notification whose reply carries one of these, or whose reply is invalid, gets an empty HTTP
   200, as in rule 6. The phone has the message and may have run it, so a status after which an
   HTTP client might send it again on its own could run it twice: 401 and 407 invite a repeat
   with new credentials (an MCP client refreshes its token and resends the message), 421 may be
   retried even for a POST, and 408, 425, 429 and a 5xx may be retried too. 413 would claim the
   message was refused before delivery. The phone's facade answers only 200, 400, 404, 405, 406,
   413 and 415, and its 413 is real: the tunnel client re-encodes the message before the facade
   checks its 262 144-byte limit, and re-encoding can make it longer (see "Decision").

Seeing that Claude or the phone went away relies on `request.signal`. Cloudflare aborts it on a
client disconnect only with the `enable_request_signal` compatibility flag, which has no
default-on date, so `wrangler.toml` sets it. The Worker hands the Durable Object the incoming
request itself, so its signal travels with it.

### Device protocol (`droidbridge-relay/1`)

The phone reuses the OpenAI tunnel client, so the relay speaks the same long-poll shape.
All device routes require `Authorization: Bearer <device key>`; the relay stores only the
SHA-256 of the key (secret `DEVICE_KEY_SHA256`, 64 lowercase hex) and compares in constant time.
Device key format: `dbrk_` followed by 43 base64url characters (32 random bytes).

| Route | Purpose | Answers |
|---|---|---|
| `GET /device/v1/status` | credential check for the app | 200 `{"schema_version":1,"protocol":"droidbridge-relay/1","authorized_clients":N,"pairing_active":bool}` |
| `GET /device/v1/poll?limit=L&timeout_ms=T` | long-poll for commands (`L` capped at 8, `T` capped at 25 000, however many digits either has; a value that is not a non-negative integer means `L` = 8, `T` = 15 000) | 200 `{"commands":[…]}` or 204 on timeout |
| `POST /device/v1/response` | result of one command; header `x-tunnel-shard-token` | 200 accepted; 400 unreadable body; 413 body too large; 404 unknown, settled, expired or token mismatch |
| `POST /device/v1/pairing` | body `{"code_sha256":"<64 lowercase hex>","ttl_seconds":≤600}`; replaces any earlier code | 200 `{"expires_at":"<RFC 3339>"}` |
| `DELETE /device/v1/pairing` | cancel the pairing code | 204 |
| `POST /device/v1/revoke` | revoke every Claude grant: tokens, codes, pending consents, registered clients, pairing | 200 `{"revoked_tokens":N}` |

Revocation also removes requests still waiting for a phone poll, answering them 403 with
`delivered:false`. A request already handed to the phone is settled with HTTP 200 and
`settlement_unknown`; the phone may already be running it, and a later reply is discarded.
A request whose body was still arriving when revocation happened checks its access token again
before hand-off, so it cannot execute after revocation.
Authorization-code or refresh-token replay withdraws outstanding requests from the affected
grant by the same rule; requests from other grants continue.

A device route answers 500 when the relay itself fails; a poll that fails this way has
delivered none of the commands it would have carried. A wrong or missing device key is 401 on
every device route. Shard-token mismatches are 404, never
401/403, because the tunnel client treats 401/403 as "operator action needed" and stops.

Command shape (one element of `commands`):

```json
{"command_type":"jsonrpc","request_id":"<uuid v4>","shard_token":"<43 base64url>",
 "channel":"main","created_at":"<RFC 3339>","response_timeout":"240s",
 "headers":{"Content-Type":["application/json"],"Accept":["application/json, text/event-stream"],
            "MCP-Protocol-Version":["2026-07-28"],"Mcp-Method":["tools/call"],"Mcp-Name":["command"]},
 "jsonrpc":{…the request body, exactly as Claude sent it (less a leading byte order mark)…}}
```

Response body posted by the phone: `{"request_id","channel","resp_json"?,"resp_headers"?,
"resp_code","resp_type":"jsonrpc_response"|"notify_ack"}`. `resp_headers` and `resp_type` are
neither forwarded nor interpreted. For a notification the relay answers Claude with `resp_code`
and no body. For a request it answers with `resp_code` and the `resp_json` text exactly as the
phone sent it, as `application/json`. In both cases a `resp_code` of 401, 407, 408, 413, 421,
425, 429 or 500 to 599 is answered as HTTP 200 instead (settlement rule 7), and every other valid
one (200 to 400, 402 to 406, 409 to 412, 414 to 420, 422 to 424, 426 to 428, 430 to 499) passes
through unchanged. A request's reply is valid only when `resp_json` is a JSON-RPC 2.0 response to
that request: a JSON object with `"jsonrpc":"2.0"`, the request's `id` (same value and type: a
string id the same string, a number id a number of exactly the same value, compared on its digits
rather than as a double, so an id above 2^53 matches only itself), and exactly one of `result` and
`error` (an object with an integer `code` and a string `message`), sent with a status that can
carry a body (not 204, 205 or 304). The response body may be up to 13 048 576 bytes (the phone's
12 000 000-byte MCP response limit plus 1 MiB of envelope).

**Invalid device replies.** A reply is invalid when:

- `resp_code` is not an integer from 200 to 599 (a 1xx cannot be a final response);
- for a request, `resp_json` is missing, is not a JSON object, or is not a JSON-RPC response to
  that request as defined above, or `resp_code` is 204, 205 or 304;
- the body cannot be read for its `request_id`: larger than the limit (answered 413), or not
  UTF-8 JSON, not a JSON object, or without a string `request_id` (answered 400). The relay then
  settles the delivered request whose shard token the `x-tunnel-shard-token` header carries at
  once instead of letting it wait for its deadline; without a matching token nothing is settled.
  A body whose upload fails mid-read settles nothing, so the phone can post it again.

In the first two cases the phone gets 200 (its reply was accepted and settled the request). A
request with an invalid reply gets HTTP 200 with a JSON-RPC error (`code -32603`,
`data.droidbridge_relay` = `{"state":"invalid_device_reply","delivered":true,"retried":false}`)
saying it may or may not have run and was not retried, and a notification gets an empty HTTP
200, as after any other reply once a notification was delivered (settlement rules 6 and 7).

Forwarded header allowlist (case-insensitive in, canonical case out, each value ≤ 4096 bytes):
`Content-Type`, `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`. Nothing else is
forwarded; in particular `Authorization`, cookies and `Mcp-Session-Id` are not.

### Claude side: MCP endpoint

`POST /mcp` only. The access token is checked first, whatever the method: a request without a
valid one is 401 (see below), and an authenticated request with any other method (GET, DELETE,
…) is 405 with `Allow: POST`. Body ≤ 262 144 bytes (413), JSON object (400),
`Content-Type: application/json` (415). It must be a JSON-RPC 2.0 request or notification:
`"jsonrpc":"2.0"`, a string `method`, and no `result` or `error` member (the phone refuses such a
message before running anything); anything else is 400, JSON-RPC `-32600`. A
request's `id` must be one the phone answers: a string, or an integer written without fraction or
exponent, from -2^63 to 2^64 - 1 (the phone reads any other number, such as `1.0`, `1e0` or
`-0`, as a float and ignores the request); anything else is 400 with `id` null. The relay's own
JSON-RPC answers echo the request's `id` exactly as Claude wrote it, a number with its digits and
a string with its escapes (`"A\/b"` stays `"A\/b"`), whenever the body has an `id` the phone
would answer, including in the `-32600` answer for a message it refuses; otherwise their `id` is
null. The 413 answer to an oversized body always has `id` null: the relay stops reading the body
at the limit and never parses it, so it does not know the `id`.

The phone gets the body text exactly as Claude sent it, never re-encoded, so a message is at most
262 144 bytes in the poll response too. The one exception is a leading UTF-8 byte order mark,
which decoding removes (the phone's parser would refuse it); every byte after it is forwarded
unchanged. The phone's JSON parser must be able to read that text, or it would drop the whole poll
response with every other command in it, so the relay refuses, before delivery, anything in it
that the phone cannot parse: nesting of objects and arrays deeper than 64 levels (the message
object is level 1; the phone stops at 128 for the whole poll response), any string or member name
holding an unpaired UTF-16 surrogate escape, such as a cut emoji `"\ud83d"`, and any number
literal that JavaScript reads (rounding it to the nearest double) as a magnitude above
1.79 × 10^308, or as infinity, such as `1e400` or `1.795e308`. The phone's parser refuses a number
beyond the double range and can overflow on one just below the largest double (about
1.7977 × 10^308), so the bound keeps clear of both. A literal that rounds to 1.79 × 10^308 itself,
such as `1.79000000000000001e308`, is accepted. The check covers the whole text, including a
member that JSON parsing would drop because a later member repeats its name. Such a message is
answered 400, JSON-RPC `-32600` with the request's `id`, or an empty 400 for a notification.

At most 16 requests in flight (429, not delivered). These pre-delivery answers (401, 405, 413,
415, 400, 429) and the not-delivered 503 of settlement rules 1 and 2 keep their status codes;
every other failure follows settlement rule 6.

Missing/invalid/expired token → 401 with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource", scope="droidbridge"`
(plus `error="invalid_token"` when a token was presented). A token is valid only for the
resource `<origin>/mcp` it was issued for (RFC 8707 audience check).

### Claude side: OAuth 2.1 authorization server

Follows the MCP 2026-07-28 authorization spec.

- `/.well-known/oauth-protected-resource` (and `…/mcp`): `resource` = `<origin>/mcp`,
  `authorization_servers` = [`<origin>`], `scopes_supported` = [`droidbridge`],
  `bearer_methods_supported` = [`header`].
- `/.well-known/oauth-authorization-server` (and `/.well-known/openid-configuration`): issuer
  `<origin>`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`,
  `response_types_supported` [`code`], `grant_types_supported` [`authorization_code`,
  `refresh_token`], `code_challenge_methods_supported` [`S256`],
  `token_endpoint_auth_methods_supported` [`none`], `scopes_supported` [`droidbridge`],
  `client_id_metadata_document_supported` true,
  `authorization_response_iss_parameter_supported` true.
- **Client ID Metadata Documents** (preferred by the spec): an `https` `client_id` with a path is
  fetched only if its host is in `CIMD_ALLOWED_HOSTS` (default `claude.ai,claude.com`), with no
  redirects, a 5 s timeout and a 16 KiB cap. The document must be a JSON object whose `client_id`
  equals the URL exactly and whose `redirect_uris` contains the requested `redirect_uri`.
  Cached for at most 1 hour.
- **Dynamic Client Registration** (`POST /register`, kept for compatibility): public clients only
  (`token_endpoint_auth_method` absent or `none`), every redirect URI must pass the redirect
  policy, at most 5 registrations per Cloudflare source IP per hour, 20 in all per hour, and
  100 stored clients. Source history uses the same salted hash and missing/malformed-IP fallback
  as pending consents. Its record expires after one hour and is purged by the next sweep; a
  distributed set of sources can still fill the global 20-per-hour allowance. Rate limiting
  new registrations does not remove existing clients.
- **Redirect policy** (applies to both): exactly `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`, loopback `http://localhost:<port>/callback` or
  `http://127.0.0.1:<port>/callback` (Claude Code), or an exact URI in `EXTRA_REDIRECT_URIS`
  (https, or http on `localhost` or `127.0.0.1`, with a host the consent page's CSP can name: a
  DNS name or IPv4 address, never an IPv6 literal such as `[::1]`, which the CSP grammar cannot
  express; any other entry is ignored).
  An invalid `client_id` or `redirect_uri` is shown as an error page and never redirected to.
- **Consent requires the phone.** `GET /authorize` validates `response_type=code`, PKCE `S256`
  (`code_challenge` 43–128 chars), `resource` (if present, must be `<origin>/mcp`) and `scope`
  (only `droidbridge`), keeps the request usable for 10 minutes and shows a page naming the
  client and its redirect host, asking for the pairing code shown in DroidBridge. The code is
  8 characters of Crockford base32 (shown `XXXX-XXXX`, 40 bits), lives at most 10 minutes, is
  single-use. Each consent request is discarded after 3 failed attempts, and at most 10
  requests per client or Cloudflare source IP (50 in all) wait at once. The relay stores only
  a device-key-salted SHA-256 of the source IP in each pending request, never the raw address;
  it is deleted when the request is answered or expires within 10 minutes. Missing or malformed
  `CF-Connecting-IP` values share one 10-request fallback bucket. Pre-upgrade pending records
  without source attribution are discarded when the next consent page is opened.
  Cloudflare normally sets this header at the edge; same-zone Worker subrequests can derive it
  from a script-modifiable `x-real-ip`, while cross-zone Worker subrequests share Cloudflare's
  Worker client IP. People behind one NAT may share a bucket, and distributed sources can still
  fill the 50-request global cap. Client registration has separate hourly limits above.
  The page answers a wrong code and a missing or expired pairing code identically, so it never
  reveals whether a pairing is active. The phone sends the relay only the code's SHA-256 (of
  the normalized uppercase code without the dash), and that hash is all the relay stores. The
  code itself reaches the relay only as typed into the consent form, which the relay hashes to
  compare and never stores or logs. The page sends `Content-Security-Policy` with
  `frame-ancestors 'none'` and a `form-action` limited to `'self'` and the redirect origin, plus
  `X-Frame-Options: DENY` and `Cache-Control: no-store`.
- `POST /authorize` with the stored request id and the code: on success the pairing code is
  consumed and the browser is redirected to `redirect_uri` with `code`, `state` and
  `iss=<origin>`. Authorization codes: 256-bit, 60 s, single use; a replayed code revokes every
  token issued from it, however late it comes and whatever `client_id`, `redirect_uri` or
  `code_verifier` comes with it, or none: a redeemed code's hash is kept for as long as the grant
  it started exists (an unredeemed one for 10 minutes after it expires), and the replay check
  runs before every check of those parameters. It needs only a well-formed token request: a POST,
  `application/x-www-form-urlencoded`, at most 16 KiB of UTF-8, no parameter repeated, and a
  supported `grant_type`. A request that is not well formed is refused (405, 413 or 400) before
  its code or refresh token is looked at, and revokes nothing.
- `POST /token` (form-encoded): `authorization_code` (PKCE S256 check, same `client_id`,
  `redirect_uri` and `resource`) and `refresh_token` (rotation; reusing a rotated refresh token
  revokes its whole family). `Cache-Control: no-store`. Only SHA-256 hashes of tokens and codes
  are stored.
- **Token formats.** Access tokens are `dbra_` followed by 43 base64url characters (256 random
  bits) and last 1 hour. Refresh tokens are `dbrr_<familyId>.<secret>` and last 30 days: the
  family id is the grant's random 128-bit id (22 base64url characters) and the secret is 256
  random bits (43 base64url characters). Each code exchange starts a family; each family keeps
  the hashes of only its last 8 access and 16 refresh tokens, and older ones are deleted.
- **Revocation durability.** The SQLite-backed object's `deleteAll()` atomically revokes every
  grant and pairing record on device disconnect. A code or refresh replay deletes its family
  record before cleaning up token hashes. Access checks, refresh checks and the authorized-client
  count require a live family, so a cleanup failure or object restart cannot revive orphan tokens;
  the next sweep removes them.
- **Replay detection survives trimming.** A presented refresh token with no record, or whose
  record is already used, counts as a replay when the grant it names (from its record, or else
  from the family id inside the token) is still live, that is, its family exists and has not
  expired: the whole family is revoked, whatever `client_id` and `scope` came with it, or none
  (as for a replayed code, the check needs only a well-formed token request and runs before
  every check of the other parameters). So a rotated token is caught however many rotations ago
  its own record was trimmed or purged. A token that is malformed, or whose family is gone or
  expired, is just `invalid_grant` and revokes nothing (a family expires together with its
  newest refresh token, so none of its tokens is live any more). A refresh token that was never
  used and has expired is answered as expired every time it is presented, until the sweep purges
  it together with its family; it is never reported as used.
- Compatibility: refresh tokens in the earlier `dbrr_<secret>` format carry no family id; the
  relay was never deployed with that format, so no such tokens exist.
- **Expired records are deleted by a sweep**, which runs at most once a minute. `GET /authorize`,
  `POST /token` and `POST /register` run it first, and every phone poll starts it without
  waiting for it. So while the phone keeps polling, an expired consent request or cached client
  document, like every other record past its lifetime, is deleted within about a minute and a
  half (up to a minute until a sweep is due, plus up to 25 s until the next poll arrives). When
  neither OAuth requests nor polls arrive, expired records stay in storage until one does; a
  consent request or cached document is never used after it expires.

## Consequences

- The user deploys and owns the relay (Cloudflare Workers free plan is enough). DroidBridge still
  runs no server of its own.
- The phone keeps its normal default-network routing (VPNs included); the client reconnects with
  bounded exponential backoff and jitter and stops on 401/403.
- A request is never executed twice by the transport. Claude may show an "outcome unknown" error;
  re-issuing it is a decision left to the user or model, with that message in front of them.

## Follow-ups

- Replace the bearer device key with a Keystore-held key pair (the phone signs a relay
  challenge), so the device credential can never be exported.
- Per-tool consent scopes once Claude surfaces step-up authorization.
