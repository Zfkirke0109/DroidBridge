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
interprets, caches, queues for later, or retries an MCP request.

### Execution settlement rules

A JSON-RPC request (a message with an `id`) whose execution outcome is unknown is never answered
with a retryable 5xx. The relay's own 4xx and 5xx statuses are kept for answers that provably did
not deliver the request: the pre-delivery answers under "Claude side: MCP endpoint" and rules 1
and 2 below. Every POST /mcp ends in exactly one of these outcomes, or in a valid reply from the
phone, which passes through with the phone's own status (see "Device protocol"). A notification
has no body to carry an error, so an invalid device reply to one is answered 502.

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
   accepted, and a poll either takes its commands with every deadline armed, or fails (HTTP 500
   to the phone) without marking any of them delivered, leaving them in the hand-off list (or
   the parked poll parked). A phone poll whose connection dropped, or was already gone when it
   reached the relay, stops counting as a waiting poll and is never handed a command.
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
   Worker passes a 5xx through only when it carries that mark: the 503 of rules 1 and 2, a
   notification's 502 for an invalid device reply, or the phone's own status on a valid reply
   (the phone, not the relay, reports that outcome). Any other 5xx on POST /mcp, and a failed
   call to the object, becomes the `D = null` answer above.

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
| `GET /device/v1/poll?limit=L&timeout_ms=T` | long-poll for commands (`L` ≤ 8, `T` capped at 25 000) | 200 `{"commands":[…]}` or 204 on timeout |
| `POST /device/v1/response` | result of one command; header `x-tunnel-shard-token` | 200 accepted; 400 unreadable body; 413 body too large; 404 unknown, settled, expired or token mismatch |
| `POST /device/v1/pairing` | body `{"code_sha256":"<64 hex>","ttl_seconds":≤600}`; replaces any earlier code | 200 `{"expires_at":"<RFC 3339>"}` |
| `DELETE /device/v1/pairing` | cancel the pairing code | 204 |
| `POST /device/v1/revoke` | revoke every Claude grant: tokens, codes, pending consents, registered clients, pairing | 200 `{"revoked_tokens":N}` |

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
 "jsonrpc":{…the request body…}}
```

Response body posted by the phone: `{"request_id","channel","resp_json"?,"resp_headers"?,
"resp_code","resp_type":"jsonrpc_response"|"notify_ack"}`. `resp_headers` and `resp_type` are
neither forwarded nor interpreted. For a notification the relay answers Claude with `resp_code`
and no body. For a request it answers with `resp_code` and `resp_json` as `application/json`,
provided `resp_json` is a JSON-RPC 2.0 response to that request: a JSON object with
`"jsonrpc":"2.0"`, the request's `id` (same value and type), and exactly one of `result` and
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
saying it may or may not have run and was not retried, and a notification gets HTTP 502.

Forwarded header allowlist (case-insensitive in, canonical case out, each value ≤ 4096 bytes):
`Content-Type`, `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`. Nothing else is
forwarded; in particular `Authorization`, cookies and `Mcp-Session-Id` are not.

### Claude side: MCP endpoint

`POST /mcp` only (GET/DELETE → 405 with `Allow: POST`). Body ≤ 262 144 bytes (413), JSON object
(400), `Content-Type: application/json` (415). The phone's JSON parser must be able to read the
message as the relay re-encodes it into a poll response, or it would drop that whole response
with every other command in it, so the relay also refuses, before delivery: nesting of objects
and arrays deeper than 64 levels (the message object is level 1; the phone stops at 128 for the
whole poll response) and any string or member name holding an unpaired UTF-16 surrogate, such as
a cut emoji `"\ud83d"` (400, JSON-RPC `-32600` with the request's `id`, or an empty 400 for a
notification), and a message larger than 262 144 bytes once re-encoded, which can happen to
numbers such as `1e20` (413, same shape). At most 16 requests in flight (429, not delivered).
These pre-delivery answers (401, 405, 413, 415, 400, 429) and the not-delivered 503 of settlement
rules 1 and 2 keep their status codes; every other failure follows settlement rule 6.

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
  policy, at most 20 registrations per hour and 100 stored clients.
- **Redirect policy** (applies to both): exactly `https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`, loopback `http://localhost:<port>/callback` or
  `http://127.0.0.1:<port>/callback` (Claude Code), or an exact URI in `EXTRA_REDIRECT_URIS`
  (https, or http on `localhost` or `127.0.0.1`, with a host the consent page's CSP can name: a
  DNS name or IPv4 address, never an IPv6 literal such as `[::1]`, which the CSP grammar cannot
  express; any other entry is ignored).
  An invalid `client_id` or `redirect_uri` is shown as an error page and never redirected to.
- **Consent requires the phone.** `GET /authorize` validates `response_type=code`, PKCE `S256`
  (`code_challenge` 43–128 chars), `resource` (if present, must be `<origin>/mcp`) and `scope`
  (only `droidbridge`), stores the request for 10 minutes and shows a page naming the client and
  its redirect host, asking for the pairing code shown in DroidBridge. The code is 8 characters
  of Crockford base32 (shown `XXXX-XXXX`, 40 bits), lives at most 10 minutes, is single-use, and
  is invalidated after 5 wrong attempts across all consent requests. Each consent request is
  discarded after 3 failed attempts, and at most 10 requests per client (50 in all) wait at once.
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
  token issued from it, however late it comes: a redeemed code's hash is kept for as long as
  the grant it started exists (an unredeemed one for 10 minutes after it expires).
- `POST /token` (form-encoded): `authorization_code` (PKCE S256 check, same `client_id`,
  `redirect_uri` and `resource`) and `refresh_token` (rotation; reusing a rotated refresh token
  revokes its whole family). `Cache-Control: no-store`. Only SHA-256 hashes of tokens and codes
  are stored.
- **Token formats.** Access tokens are `dbra_` followed by 43 base64url characters (256 random
  bits) and last 1 hour. Refresh tokens are `dbrr_<familyId>.<secret>` and last 30 days: the
  family id is the grant's random 128-bit id (22 base64url characters) and the secret is 256
  random bits (43 base64url characters). Each code exchange starts a family; each family keeps
  the hashes of only its last 8 access and 16 refresh tokens, and older ones are deleted.
- **Replay detection survives trimming.** A presented refresh token with no live record, or whose
  record is already used, counts as a replay when the family it names (from its record, or else
  from the family id inside the token) still exists: the whole family is revoked, whatever
  `client_id` came with it. So a rotated token is caught however many rotations ago its own
  record was trimmed or purged. A token that is malformed or whose family is gone is just
  `invalid_grant` and revokes nothing.
- Compatibility: refresh tokens in the earlier `dbrr_<secret>` format carry no family id; the
  relay was never deployed with that format, so no such tokens exist.

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
