# EgressView REST API Reference

> [Japanese / 日本語](api-reference.ja.md)

EgressView exposes a private administration API for its web UI and local automation. The API is not yet a versioned public compatibility contract; review release notes before upgrading an external integration.

## Base URL and authentication

API paths are rooted at `/api`, even when the web UI is served below a subpath. Protected requests accept the legacy `X-Admin-Token`, a scoped API identity token in the same header, or an HttpOnly browser session cookie. Cookie-authenticated mutations also require the matching `X-CSRF-Token`.

Scoped API identities are managed through `GET` / `POST /api/auth/api-identities` and `POST /api/auth/api-identities/:id/revoke`, all requiring `auth.admin`. Creation requires a label, a non-empty permission list, and `expiresInMs` between one minute and one year. The plaintext `egv_...` token is returned only in the `201` creation response; only its SHA-256 hash is stored. Identity-management responses use `Cache-Control: no-store`.

Mac and future endpoint Agents use a separate credential boundary. An administrator creates a one-time, 10-minute enrollment code with `POST /api/agents/enrollment-tokens`; the Agent exchanges it over HTTPS at `POST /api/agent/enroll`. The `egva_...` bearer returned by that response is stored in the macOS Keychain, while the Hub stores only a peppered hash. It grants only `agent.ingest`, cannot authenticate browser/admin/MCP routes, and is accepted by `POST /api/agent/token/rotate`. Agent inventory and revocation (`GET /api/agents`, `POST /api/agents/:agentId/revoke`) require `auth.admin`. All Agent responses are non-cacheable, enrollment codes are shown once, and HTTP is accepted only on a loopback development listener.

`GET /api/auth/api-identities/self` returns only the currently authenticated
scoped identity and requires `network.read`; browser sessions and the legacy
admin token are rejected. The remote MCP server uses it to fail closed unless
its internal service identity grants exactly `network.read` and `notes.write`.

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

`POST /api/admin/verify` is also public and verifies a token supplied in the request body. Authentication status/method discovery, the OIDC redirect/callback, and the one-time-code-protected `POST /api/agent/enroll` entry point are public. The detail-free `/healthz` and `/readyz` checks are public; all other endpoints require their documented browser, API identity, or Agent credential.

## Common behavior

- Timestamps are Unix epoch milliseconds. Empty `from` and `to` values mean an open time range unless an endpoint says otherwise.
- Every response includes `X-Request-Id`. A caller ID matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}` is preserved; a missing or unsafe value is replaced with a generated UUID. The same safe ID correlates request, asynchronous, slow-request, and error logs. Query strings are not included in HTTP completion logs.
- Every endpoint-bearing route module validates request bodies, query strings, and path parameters at a strict Zod boundary. Unknown fields, arrays or objects supplied for scalar parameters, and values over the documented limits return `400` before application state is changed.
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

- `GET /api/backup/list` lists normal generations, retention settings, normal/pre-migration inventory, disk headroom, and next-migration readiness. Inventory entries are lightweight and report `integrity: "unchecked"` until a verified cleanup preview runs.
- `POST /api/backup/create` creates and verifies a consistent SQLite snapshot.
- `GET /api/backup/download/:name` downloads a named generation.
- `POST /api/backup/restore` uses `{ "name": "..." }`.
- `POST /api/backup/upload` accepts a raw SQLite file body up to 100 MB, not multipart form data.
- `POST /api/backup/config` accepts positive `intervalHours`, `maxGenerations` (minimum 2), non-negative `maxBackupBytes` (`0` disables the storage cap), and boolean `autoPrune`. Auto-prune defaults to off.
- `POST /api/backup/prune` accepts `{ "execute": false }` for a verified dry-run or `{ "execute": true }` for confirmed cleanup and returns `202` with a worker job. Integrity checks run outside the main event loop, so collection and HTTP remain responsive. Only one cleanup job may run; another request receives `409`.
- `GET /api/backup/prune/:jobId` returns job status (`running`, `cancelling`, `timing_out`, `completed`, `cancelled`, `timed_out`, or `failed`), progress, and the completed plan/result. `DELETE /api/backup/prune/:jobId` requests safe cancellation. Cleanup always keeps two normal generations and the latest verified migration generation; corrupt, unverified, changed, and temporary files are never deleted.

## Process health

- `GET /healthz` is an unauthenticated, cache-disabled liveness check and returns only `{ "status": "ok" }` when the Node.js event loop can respond.
- `GET /readyz` is an unauthenticated, cache-disabled readiness check. It returns `503` with `{ "status": "not_ready" }` until configuration and DB bootstrap complete, then `200` with `{ "status": "ready" }`. It exposes no router, database, or credential details.

## AI provider configuration

AI insights always shows locally calculated facts. Only after an explicit user action, it sends aggregates — including destination IPs, hostnames, device names, and MAC addresses — to the configured AI provider. Credentials such as passwords are never sent.

- `GET /api/config/ai` returns the selected provider, model IDs, Ollama endpoint, AWS `region`, key-set/consent flags, and `selectedModelPricing`. API key values are never returned.
- `POST /api/config/ai` accepts `provider` (`disabled`, `ollama`, `anthropic`, `openai`, or `bedrock`), provider-keyed `models`, `ollamaEndpoint`, a Bedrock `region`, optional cloud `keys`, and `clearKeys`. Any externally transmitting provider (`anthropic`, `openai`, `bedrock`) requires provider-specific `cloudConsent: true`. Bedrock stores no key and delegates authentication to the AWS SDK default credential chain; `models.bedrock` accepts a foundation model ID, a cross-region inference profile ID (`global`/`us`/`eu`/`apac`/`jp`/`au`), or an ARN (up to 400 chars). An optional `guardrail` (`{ enabled, id, version }`) attaches a Bedrock Guardrail, passed to Converse via `guardrailConfig` when enabled (requires `bedrock:ApplyGuardrail`); note that Guardrails do not guarantee in-Japan processing (see `docs/setup-bedrock.md`).
- `POST /api/ai/models` accepts a Bedrock `region` and retrieves at most 200 text-generation model/inference-profile IDs without running inference. The response adds `modelPricing` coverage while retaining the string `models` array. Specialized image, audio, embedding, and similar IDs are omitted from the picker, but manual model entry remains available as a fallback.
- `POST /api/ai/pricing/check` accepts a provider and model ID and reports whether the versioned catalog has a matching standard token rate. It does not contact the provider or invoke a model.
- `POST /api/ai/guardrails` accepts a Bedrock `region` and lists that region's Guardrails (id, name, and versions) without running inference. Fail-open: a missing `bedrock:ListGuardrails` permission returns an empty list so the settings UI falls back to manual guardrail entry.
- `POST /api/ai/test` accepts an empty JSON object. Fetch-based providers retrieve at most 200 model IDs (10-second timeout, 1 MB limit). Bedrock runs fail-open model discovery and additionally sends a short fixed string via Converse to verify `bedrock:InvokeModel` permission (no network, device, or threat data is sent).
- `GET /api/ai/facts` requires `from` and accepts `to` as epoch milliseconds. It returns current and immediately preceding equal-period counts for connections, devices, destinations, and threat levels, plus credential-free router collection status. The range is capped at 14 days and no data is sent to an AI provider.
- `POST /api/ai/analyze` accepts `from` and optional `to`, then sends connection aggregates plus a bounded device inventory (up to 30 activity-prioritized devices) and ASUS network-node summaries (up to 10 nodes and 5 sample devices per node). Fields can include destination/source IPs, hostnames, device names, MACs, vendors, IPv6, first/last seen, source, status, and counts. Credentials, device notes, archived devices, router/node management IPs, and raw logs are excluded. Externally transmitting providers (Anthropic/OpenAI/Bedrock) require both saved consent and `cloudConsentConfirmed: true` on each request. The range is capped at 14 days, timeout is 30 seconds, and only one analysis may run server-wide.
- `GET /api/ai/usage/monthly` accepts the browser `timezoneOffset` in minutes and returns current/previous local-calendar-month request and token totals. Its `pricing` object includes the catalog version, effective date, and source URLs. `pricedTokens`, `unpricedTokens`, and grouped `unpricedModels` make clear when estimated USD is only a partial total. Successful Ollama, Anthropic, OpenAI, and Bedrock calls are appended to v7 SQLite with the provider/model and the price-table version and rates used at invocation time, so later catalog updates do not recalculate prior months. `unknownPriceRequests` and provider responses without usage (`usageMissingRequests`) remain distinct and are never mislabeled as USD 0; add-on charges such as Bedrock Guardrails are excluded. Conversation retrieval joins `usageInputTokens`, `usageOutputTokens`, `usageTotalTokens`, `estimatedCostUsd`, and `pricingVersion` from the same request onto assistant messages; history created before usage recording keeps provider/model with null usage instead of inferred values. The UI uses `$` in English and explicit `USD` notation in Japanese without currency conversion.
- `GET /api/ai/pricing/diagnostics` accepts `timezoneOffset` and returns the selected model's catalog status plus grouped unpriced models for the current and previous local month. It exposes model IDs and usage totals, never API keys or prompt/network contents.
- `POST /api/ai/chat` accepts a `message` of at most 4,000 characters, a range, and optional `conversationId` and `requestId`. It appends the user row to v6 SQLite before calling AI, then appends an assistant row on success or a body-free failure row. The same `requestId + role` is never duplicated.
- `GET /api/ai/conversations` returns at most 100 conversations plus stored counts and body bytes. `GET /api/ai/conversations/:id` returns at most 500 messages in append order, while `DELETE /api/ai/conversations/:id` is the only explicit conversation deletion path. Restart and configuration changes never update or truncate existing rows.

Provider configuration is disabled by default. Anthropic and OpenAI use their fixed official API endpoints; only Ollama accepts a custom HTTP(S) endpoint. Bedrock uses a region and the Converse API, delegating authentication to the AWS SDK default credential chain (no key entry or storage). Bedrock support ships as a standard dependency (`@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock`); no extra install. See `docs/setup-bedrock.md`.

Restore is fail-closed: EgressView validates the source, confirms a safety backup, restores and reopens all database users, verifies the result, and rolls back on failure. Active browser sessions are revoked after a successful restore.

## Endpoint catalog

All 99 implemented HTTP endpoints are listed below. **Public** means no browser or API token is required. Protected endpoints accept the documented legacy/scoped `X-Admin-Token`, browser HttpOnly session cookie, or Agent bearer; cookie-authenticated mutations additionally require `X-CSRF-Token`.

| Area | Method and path | Access |
|---|---|---|
| Authentication | `POST /api/auth/login` | Public |
| Authentication | `POST /api/admin/verify` | Public |
| Authentication | `GET /api/auth/status` | Public |
| Authentication | `GET /api/auth/methods` | Public |
| Authentication | `GET /api/auth/oidc/start` | Public |
| Authentication | `GET /api/auth/oidc/callback` | Public |
| Authentication | `POST /api/auth/logout` | Protected |
| Authentication | `GET /api/auth/sessions` | Protected |
| Authentication | `POST /api/auth/sessions/:id/revoke` | Protected |
| Authentication | `POST /api/auth/sessions/revoke-all` | Protected |
| Authentication | `POST /api/auth/change-password` | Protected |
| Authentication | `POST /api/admin/regenerate-token` | Protected |
| Authentication | `GET /api/auth/security-config` | Protected |
| Authentication | `POST /api/auth/security-config` | Protected |
| Authentication | `POST /api/auth/oidc/test` | Protected |
| Authentication | `GET /api/auth/api-identities` | Protected |
| Authentication | `POST /api/auth/api-identities` | Protected |
| Authentication | `POST /api/auth/api-identities/:id/revoke` | Protected |
| Authentication | `GET /api/auth/audit-events` | Protected |
| Agent | `POST /api/agents/enrollment-tokens` | Protected; `auth.admin`, returns the code once |
| Agent | `POST /api/agent/enroll` | Public; one-time code and HTTPS required |
| Agent | `GET /api/agents` | Protected; `auth.admin`, never returns credential hashes |
| Agent | `POST /api/agents/:agentId/revoke` | Protected; `auth.admin` |
| Agent | `POST /api/agent/token/rotate` | Agent bearer; `agent.ingest` only |
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
| Backup | `POST /api/backup/prune` | Protected |
| Backup | `GET /api/backup/prune/:jobId` | Protected |
| Backup | `DELETE /api/backup/prune/:jobId` | Protected |
| Process health | `GET /healthz` | Public; minimal liveness only |
| Process health | `GET /readyz` | Public; minimal readiness only |
| General configuration | `GET /api/status` | Protected |
| General configuration | `POST /api/config/general` | Protected |
| Data sources | `GET /api/config/datasources` | Protected |
| Data sources | `POST /api/config/datasources` | Protected |
| Slack | `GET /api/config/slack` | Protected |
| Slack | `POST /api/config/slack` | Protected |
| Notifications | `GET /api/config/detection-notifications` | Protected |
| Notifications | `POST /api/config/detection-notifications` | Protected |
| Manual threat investigation | `GET /api/config/manual-threat` | Protected; returns key-set flags, never key values |
| Manual threat investigation | `POST /api/config/manual-threat` | Protected; saves API keys, cache, and provider cooldown |
| Manual threat investigation | `POST /api/threat/manual-lookup` | Protected; explicitly sends one public IP to selected providers |
| AI configuration | `GET /api/config/ai` | Protected; returns key-set flags, never key values |
| AI configuration | `POST /api/config/ai` | Protected; saves provider, models, endpoint, and cloud keys |
| AI configuration | `POST /api/ai/models` | Protected; discovers Bedrock model/profile IDs without inference |
| AI configuration | `POST /api/ai/pricing/check` | Protected; checks embedded pricing coverage without provider access |
| AI configuration | `POST /api/ai/guardrails` | Protected; discovers Bedrock guardrails without inference (fail-open) |
| AI configuration | `POST /api/ai/test` | Protected; retrieves model IDs without sending network data |
| AI insights | `GET /api/ai/facts` | Protected; local facts and prior-period comparison only |
| AI insights | `GET /api/ai/usage/monthly` | Protected; current and previous local-month token usage and approximate USD cost |
| AI insights | `GET /api/ai/pricing/diagnostics` | Protected; selected-model status and grouped unpriced usage |
| AI insights | `POST /api/ai/analyze` | Protected; manually analyzes aggregates (incl. destination IPs, hostnames, device names, MAC); cloud requires double consent |
| AI notifications | `GET /api/ai/notification-config` | Protected; returns schedule, trigger, destination, and runtime status |
| AI notifications | `POST /api/ai/notification-config` | Protected; saves validated scheduling and automation consent settings |
| AI notifications | `GET /api/ai/notification-events` | Protected; returns up to 200 append-only delivery records |
| AI notifications | `POST /api/ai/notification-test` | Protected; tests UI/Slack delivery without invoking AI |
| AI notifications | `POST /api/ai/notification-run-now` | Protected; explicitly runs the configured analysis range |
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
