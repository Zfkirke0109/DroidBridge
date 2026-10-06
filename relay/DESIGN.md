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

1. **Offline means not delivered.** A request that arrives while no phone poll is waiting (and no
   poll ended in the last 5 s) is answered at once with HTTP 503 and a JSON-RPC error whose
   `data.droidbridge_relay` is `{"state":"offline","delivered":false}`. Nothing is queued.
2. **Hand-off window.** If the phone is online but between polls, the request waits at most 5 s
   for the next poll. If none comes it is dropped from memory and answered like rule 1
   (`"state":"unavailable","delivered":false`). It can never be delivered later.
3. **Exactly one delivery.** A command is handed to exactly one poll response, then removed from
   the hand-off list. A later poll never sees it again.
4. **Unknown settlement is final.** If the phone does not post a response before the command's
   deadline (`response_timeout` + 5 s grace), the relay answers HTTP 200 with a JSON-RPC error
   (`code -32002`, `data.droidbridge_relay` = `{"state":"settlement_unknown","delivered":true,
   "retried":false}`) saying the request may or may not have run and was not retried. HTTP 200
   keeps HTTP-layer clients from replaying it. A late response for that request gets 404.
5. Notifications follow the same rules but get no JSON-RPC body.

### Device protocol (`droidbridge-relay/1`)

The phone reuses the OpenAI tunnel client, so the relay speaks the same long-poll shape.
All device routes require `Authorization: Bearer <device key>`; the relay stores only the
SHA-256 of the key (secret `DEVICE_KEY_SHA256`, 64 lowercase hex) and compares in constant time.
Device key format: `dbrk_` followed by 43 base64url characters (32 random bytes).

| Route | Purpose | Answers |
|---|---|---|
| `GET /device/v1/status` | credential check for the app | 200 `{"schema_version":1,"protocol":"droidbridge-relay/1","authorized_clients":N,"pairing_active":bool}` |
| `GET /device/v1/poll?limit=L&timeout_ms=T` | long-poll for commands (`L` ≤ 8, `T` capped at 25 000) | 200 `{"commands":[…]}` or 204 on timeout |
| `POST /device/v1/response` | result of one command; header `x-tunnel-shard-token` | 200 accepted; 404 unknown, settled, expired or token mismatch |
| `POST /device/v1/pairing` | body `{"code_sha256":"<64 hex>","ttl_seconds":≤600}`; replaces any earlier code | 200 `{"expires_at":"<RFC 3339>"}` |
| `DELETE /device/v1/pairing` | cancel the pairing code | 204 |
| `POST /device/v1/revoke` | revoke every Claude grant: tokens, codes, pending consents, registered clients, pairing | 200 `{"revoked_tokens":N}` |

A wrong or missing device key is 401 on every device route. Shard-token mismatches are 404, never
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
"resp_code","resp_type":"jsonrpc_response"|"notify_ack"}`. The relay answers Claude with
`resp_code` (100–599, else 502) and `resp_json` as `application/json`.

Forwarded header allowlist (case-insensitive in, canonical case out, each value ≤ 4096 bytes):
`Content-Type`, `Accept`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`. Nothing else is
forwarded; in particular `Authorization`, cookies and `Mcp-Session-Id` are not.

### Claude side: MCP endpoint

`POST /mcp` only (GET/DELETE → 405 with `Allow: POST`). Body ≤ 262 144 bytes (413), JSON object
(400), `Content-Type: application/json` (415). At most 16 requests in flight (429, not delivered).

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
  `http://127.0.0.1:<port>/callback` (Claude Code), or an exact URI in `EXTRA_REDIRECT_URIS`.
  An invalid `client_id` or `redirect_uri` is shown as an error page and never redirected to.
- **Consent requires the phone.** `GET /authorize` validates `response_type=code`, PKCE `S256`
  (`code_challenge` 43–128 chars), `resource` (if present, must be `<origin>/mcp`) and `scope`
  (only `droidbridge`), stores the request for 10 minutes and shows a page naming the client and
  its redirect host, asking for the pairing code shown in DroidBridge. The code is 8 characters
  of Crockford base32 (shown `XXXX-XXXX`, 40 bits), lives at most 10 minutes, is single-use, and
  is invalidated after 5 wrong attempts. Only its SHA-256 (of the normalized uppercase code
  without the dash) ever reaches the relay. The page sends `Content-Security-Policy` with
  `frame-ancestors 'none'` and a `form-action` limited to `'self'` and the redirect origin, plus
  `X-Frame-Options: DENY` and `Cache-Control: no-store`.
- `POST /authorize` with the stored request id and the code: on success the pairing code is
  consumed and the browser is redirected to `redirect_uri` with `code`, `state` and
  `iss=<origin>`. Authorization codes: 256-bit, 60 s, single use; a replayed code revokes every
  token issued from it.
- `POST /token` (form-encoded): `authorization_code` (PKCE S256 check, same `client_id`,
  `redirect_uri` and `resource`) and `refresh_token` (rotation; reusing a rotated refresh token
  revokes its whole family). Access tokens 256-bit opaque, 1 hour; refresh tokens 30 days.
  `Cache-Control: no-store`. Only SHA-256 hashes of tokens and codes are stored.

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
