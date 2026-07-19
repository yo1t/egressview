# EgressView REST API Reference

> [Japanese / 日本語](api-reference.ja.md)

EgressView exposes a private administration API for its web UI and local automation. The API is not yet a versioned public compatibility contract; review release notes before upgrading an external integration.

## Base URL and authentication

API paths are rooted at `/api`, even when the web UI is served below a subpath. Except for the two public authentication endpoints noted below, every request requires an `X-Admin-Token` header containing either an admin token or a browser session token.

```bash
export EGRESSVIEW_URL='https://egressview.example.net'
export EGRESSVIEW_TOKEN='replace-with-your-admin-token'

curl --fail-with-body \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  "$EGRESSVIEW_URL/api/status"
```

Use HTTPS or a trusted VPN when crossing a network boundary. Never put a token in a URL, log, or source file. The JSON request-body limit is 64 KB.

### Password login

`POST /api/auth/login` is public and exchanges the UI password for a revocable session token. A password may contain at most 256 characters. Five failed attempts from one client trigger a five-minute lockout within the ten-minute tracking window.

```bash
curl --fail-with-body \
  -H 'Content-Type: application/json' \
  -d '{"password":"replace-with-your-password"}' \
  "$EGRESSVIEW_URL/api/auth/login"
```

```json
{"success":true,"token":"session-token","expiresAt":1784304000000}
```

`POST /api/admin/verify` is also public and verifies a token supplied in the request body. All other endpoints are protected.

## Common behavior

- Timestamps are Unix epoch milliseconds. Empty `from` and `to` values mean an open time range unless an endpoint says otherwise.
- Successful JSON responses use `application/json`; errors normally use `{ "error": "message" }`.
- Common status codes are `400` for invalid input, `401` for invalid authentication, `404` for a missing resource, `413` for an oversized upload, `500` for an internal or persistence failure, `502` for router detection failure, and `503` while authentication is not initialized.
- Router passwords, enable passwords, host fingerprints, and admin tokens are never returned by router-list APIs.
- MCP is a separate protocol. See the [MCP setup guide](setup-mcp.md) instead of using these REST paths through an MCP client.

## Connections

### List connection history

`GET /api/connections`

| Query | Description |
|---|---|
| `from`, `to` | Optional epoch-millisecond range. |
| `limit`, `offset` | Pagination. `limit` is clamped to 1,000. The unpaged compatibility form is capped at 50,000 rows and returns `truncated`; the graph uses `/api/connections/summary`. |
| `sort` | `lastSeen`, `src`, `dst`, `dport`, `proto`, `country`, or `org`; default `lastSeen`. |
| `sortDir` | `asc` or `desc`; default `desc`. |
| `fSrc`, `fDst`, `fDport`, `fProto`, `fCountry`, `fOrg` | Server-side column filters. Append `Mode` with `contains`, `startsWith`, `endsWith`, or `exact`. |
| `fSrcMac` | Exact source-MAC filter. |
| `fThreat` | `safe`, `warn`, or `danger`. |

```bash
curl --fail-with-body \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  "$EGRESSVIEW_URL/api/connections?from=1784217600000&limit=100&sort=lastSeen&sortDir=desc"
```

The response contains `connections`, `total`, `limit`, `offset`, and `serverTime`. Each connection can include source-device metadata, destination enrichment, `firstSeen`, `lastSeen`, `observedBy` router IDs, a compatibility `source` value derived from those routers, and an optional `threat` object.

### Summary and security views

- `GET /api/connections/summary` accepts `from`, `to`, optional `src`, and `buckets` from 1 to 240 (default 60).
- `GET /api/connections/new-nodes` returns newly observed source and destination nodes for a time range.
- `GET /api/connections/threat-connections` accepts `confidence=low|high|all` and a `limit` capped at 200.
- `GET /api/connections/threat-counts` returns `safe`, `warn`, and `danger` counts and accepts the standard server-side filters.
- `GET /api/connections/memory` reports the in-memory working-set statistics.

### Export CSV or JSON

`GET /api/connections/export` requires `format=csv|json` and `from`; `to` defaults to the current time.

```bash
curl --fail-with-body \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  "$EGRESSVIEW_URL/api/connections/export?format=csv&from=1784217600000" \
  -o connections.csv
```

Exports stream in pages of 1,000, stop at 50,000 rows, and time out after 60 seconds. Inspect `X-Export-Total`, `X-Export-Count`, and `X-Export-Truncated`. CSV is UTF-8 with a BOM and applies spreadsheet-formula injection protection. JSON returns `meta` and `connections`.

## Routers

EgressView supports up to 10 enabled or disabled Yamaha/Cisco records.

- `GET /api/routers` returns safe public fields and runtime status.
- `POST /api/routers/detect` tests an unsaved router definition and returns detected LAN/NAT information or `502` diagnostics.
- `POST /api/routers` creates a router and returns `201`.
- `PUT /api/routers/:id` updates a router; its `kind` and stable router ID cannot be changed.
- `DELETE /api/routers/:id` removes it from active configuration while historical observations remain attributable to its tombstoned ID.

Create/detect bodies use `kind` (`yamaha` or `cisco`), `displayName`, `ip`, `user`, `pass`, and `enabled`. Yamaha also uses `nat`; Cisco may use `enablePass`. Omitting a password during update preserves the stored value.

## Devices and notes

- `GET /api/devices` accepts `includeArchived=1` and returns identity, status, IPv6 addresses, and notes.
- `GET /api/devices/merge-candidates` accepts `status=pending|approved|rejected|all`.
- `POST /api/devices/merge` uses `{ "keepId": "...", "dropId": "..." }`.
- `POST /api/devices/reject` uses `{ "id": "..." }`.
- `POST /api/devices/archive` and `POST /api/devices/unarchive` use `{ "deviceId": "..." }`.
- `GET /api/notes` queries saved notes. `POST /api/notes` writes a note of at most 500 characters. `POST /api/notes/draft` produces a draft through the configured assistant integration.

## Backup and restore

- `GET /api/backup/list` lists generations and retention settings.
- `POST /api/backup/create` creates and verifies a consistent SQLite snapshot.
- `GET /api/backup/download/:name` downloads a named generation.
- `POST /api/backup/restore` uses `{ "name": "..." }`.
- `POST /api/backup/upload` accepts a raw SQLite file body up to 100 MB, not multipart form data.
- `POST /api/backup/config` accepts positive `intervalHours` and `maxGenerations` values.

## AI provider configuration

AI insights always shows locally calculated facts. It sends anonymized aggregates to the configured AI provider only after an explicit user action.

- `GET /api/config/ai` returns the selected provider, model IDs, Ollama endpoint, AWS `region`, and key-set/consent flags. API key values are never returned.
- `POST /api/config/ai` accepts `provider` (`disabled`, `ollama`, `anthropic`, `openai`, or `bedrock`), provider-keyed `models`, `ollamaEndpoint`, a Bedrock `region`, optional cloud `keys`, and `clearKeys`. Any externally transmitting provider (`anthropic`, `openai`, `bedrock`) requires provider-specific `cloudConsent: true`. Bedrock stores no key and delegates authentication to the AWS SDK default credential chain; `models.bedrock` accepts a foundation model ID, a cross-region inference profile ID (`global`/`us`/`eu`/`apac`/`jp`/`au`), or an ARN (up to 400 chars).
- `POST /api/ai/test` accepts an empty JSON object. Fetch-based providers retrieve at most 200 model IDs (10-second timeout, 1 MB limit). Bedrock runs fail-open model discovery and additionally sends a short fixed string via Converse to verify `bedrock:InvokeModel` permission (no network, device, or threat data is sent).
- `GET /api/ai/facts` requires `from` and accepts `to` as epoch milliseconds. It returns current and immediately preceding equal-period counts for connections, devices, destinations, and threat levels, plus credential-free router collection status. The range is capped at 14 days and no data is sent to an AI provider.
- `POST /api/ai/analyze` accepts `from` and optional `to`, then sends aggregates without internal IPs, MAC addresses, device names, router management details, or raw logs to the selected provider. Externally transmitting providers (Anthropic/OpenAI/Bedrock) require both saved consent and `cloudConsentConfirmed: true` on each request. The range is capped at 14 days, timeout is 30 seconds, and only one analysis may run server-wide.
- `POST /api/ai/chat` accepts a `message` of at most 4,000 characters, a range, and optional `conversationId` and `requestId`. It appends the user row to v6 SQLite before calling AI, then appends an assistant row on success or a body-free failure row. The same `requestId + role` is never duplicated.
- `GET /api/ai/conversations` returns at most 100 conversations plus stored counts and body bytes. `GET /api/ai/conversations/:id` returns at most 500 messages in append order, while `DELETE /api/ai/conversations/:id` is the only explicit conversation deletion path. Restart and configuration changes never update or truncate existing rows.

Provider configuration is disabled by default. Anthropic and OpenAI use their fixed official API endpoints; only Ollama accepts a custom HTTP(S) endpoint. Bedrock uses a region and the Converse API, delegating authentication to the AWS SDK default credential chain (no key entry or storage). Bedrock support ships as a standard dependency (`@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock`); no extra install. See `docs/setup-bedrock.md`.

Restore is fail-closed: EgressView validates the source, confirms a safety backup, restores and reopens all database users, verifies the result, and rolls back on failure. Active browser sessions are revoked after a successful restore.

## Endpoint catalog

All 60 implemented REST endpoints are listed below. **Public** means no token is required; every other row requires `X-Admin-Token`.

| Area | Method and path | Access |
|---|---|---|
| Authentication | `POST /api/auth/login` | Public |
| Authentication | `POST /api/admin/verify` | Public |
| Authentication | `POST /api/auth/logout` | Protected |
| Authentication | `GET /api/auth/sessions` | Protected |
| Authentication | `POST /api/auth/sessions/:id/revoke` | Protected |
| Authentication | `POST /api/auth/sessions/revoke-all` | Protected |
| Authentication | `POST /api/auth/change-password` | Protected |
| Authentication | `POST /api/admin/regenerate-token` | Protected |
| Router setup | `POST /api/nonce` | Protected |
| Router setup | `POST /api/yamaha/detect` | Protected |
| Router setup | `POST /api/cisco/detect` | Protected |
| Router setup | `POST /api/login` | Protected, legacy setup flow |
| Routers | `GET /api/routers` | Protected |
| Routers | `POST /api/routers/detect` | Protected |
| Routers | `POST /api/routers` | Protected |
| Routers | `PUT /api/routers/:id` | Protected |
| Routers | `DELETE /api/routers/:id` | Protected |
| Connections | `GET /api/connections` | Protected |
| Connections | `GET /api/connections/memory` | Protected |
| Connections | `GET /api/connections/summary` | Protected |
| Connections | `GET /api/connections/new-nodes` | Protected |
| Connections | `GET /api/connections/threat-connections` | Protected |
| Connections | `GET /api/connections/threat-counts` | Protected |
| Connections | `GET /api/connections/export` | Protected |
| Devices | `GET /api/devices` | Protected |
| Devices | `GET /api/devices/merge-candidates` | Protected |
| Devices | `POST /api/devices/merge` | Protected |
| Devices | `POST /api/devices/reject` | Protected |
| Devices | `POST /api/devices/archive` | Protected |
| Devices | `POST /api/devices/unarchive` | Protected |
| Notes | `GET /api/notes` | Protected |
| Notes | `POST /api/notes` | Protected |
| Notes | `POST /api/notes/draft` | Protected |
| Backup | `GET /api/backup/list` | Protected |
| Backup | `POST /api/backup/create` | Protected |
| Backup | `GET /api/backup/download/:name` | Protected |
| Backup | `POST /api/backup/restore` | Protected |
| Backup | `POST /api/backup/upload` | Protected |
| Backup | `POST /api/backup/config` | Protected |
| General configuration | `GET /api/status` | Protected |
| General configuration | `POST /api/config/general` | Protected |
| Data sources | `GET /api/config/datasources` | Protected |
| Data sources | `POST /api/config/datasources` | Protected |
| Slack | `GET /api/config/slack` | Protected |
| Slack | `POST /api/config/slack` | Protected |
| Manual threat investigation | `GET /api/config/manual-threat` | Protected; returns key-set flags, never key values |
| Manual threat investigation | `POST /api/config/manual-threat` | Protected; saves API keys, cache, and provider cooldown |
| Manual threat investigation | `POST /api/threat/manual-lookup` | Protected; explicitly sends one public IP to selected providers |
| AI configuration | `GET /api/config/ai` | Protected; returns key-set flags, never key values |
| AI configuration | `POST /api/config/ai` | Protected; saves provider, models, endpoint, and cloud keys |
| AI configuration | `POST /api/ai/test` | Protected; retrieves model IDs without sending network data |
| AI insights | `GET /api/ai/facts` | Protected; local facts and prior-period comparison only |
| AI insights | `POST /api/ai/analyze` | Protected; manually analyzes anonymized aggregates; cloud requires double consent |
| AI chat | `POST /api/ai/chat` | Protected; appends the question first and stores an answer or failure row |
| AI chat | `GET /api/ai/conversations` | Protected; conversation list and storage usage |
| AI chat | `GET /api/ai/conversations/:id` | Protected; message history preserved across restarts |
| AI chat | `DELETE /api/ai/conversations/:id` | Protected; explicit conversation-level deletion |
| Slack | `POST /api/slack/test` | Protected |
| Slack | `POST /api/slack/verify` | Protected |
| Slack | `POST /api/slack/lookup-user` | Protected |
| Detection log | `GET /api/notification-log` | Protected |
| Beacons | `GET /api/beacons` | Protected |
| Beacons | `GET /api/beacons/config` | Protected |
| Beacons | `POST /api/beacons/config` | Protected |
| Beacons | `POST /api/beacons/:id/dismiss` | Protected |
