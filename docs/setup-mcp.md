# AI Agent Access via MCP

EgressView exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI assistants — including AWS Kiro, Anthropic Claude, Anysphere Cursor, Zed, and any MCP-compatible agent — query your network data directly.

> 🇯🇵 [日本語版はこちら](setup-mcp.ja.md)

The MCP SDK v2 server uses one tool definition for both protocol eras:
`2025-11-25` clients use the legacy `initialize` flow, while `2026-07-28`
clients use stateless `server/discover` and per-request metadata. The legacy
fallback is retained for compatibility; no sticky session is required.

Before choosing a transport, select one of the cloud-neutral
[deployment profiles](deployment-profiles.md): `local-stdio`, `private-http`,
`private-oauth`, or `public-oauth`. Set `EGRESSVIEW_DEPLOYMENT_PROFILE`
explicitly in managed environments; a transport/authentication mismatch fails
before the endpoint starts.

## Example Conversations

Once connected, just ask in natural language:

```
"Show me a threat summary for the last 24 hours"
→ 18,142 sessions total: 18,117 safe, 25 warn, 0 danger

"Which devices made the most connections today?"
→ Lists top devices with session counts, MAC, vendor

"Any new devices on the network this week?"
→ Reports first-seen devices and destinations in the last 7 days

"Are there any threat connections right now?"
→ Lists destinations flagged by Feodo, ThreatFox, URLhaus, or Spamhaus DROP

"What is 192.168.1.50 connecting to?"
→ Top destinations for that device with country, org, and threat level

"Show me all alerts from the last 6 hours"
→ Detection log: threat hits, new device alerts, beacon candidates

"Show me all device notes"
→ Lists every device that has a memo attached

"Add a note to 192.168.1.97: Roomba, connects to GitHub for OTA updates"
→ Saves the memo to that device
```

The agent selects the appropriate tool automatically and combines multiple tool calls when needed.

## Available Tools

| Tool | What it returns |
|---|---|
| `get_threat_summary` | safe / warn / danger session counts for a time period |
| `get_traffic_summary` | total sessions, unique destinations, unique devices |
| `get_top_destinations` | top contacted destinations (ranked by session count, with country, org, threat level) |
| `get_device_traffic` | per-device traffic; pass a src IP to get one device's top destinations |
| `get_new_nodes` | devices and destinations first seen during the period |
| `get_threat_connections` | destinations flagged as threats (low/high confidence) |
| `get_alerts` | detection log entries (threats, new devices, beacons) |
| `get_devices` | all known LAN devices with MAC, vendor, status, last-seen |
| `query_connections` | connection log search with src/dst filters |
| `get_device_notes` | device memo notes; omit src for all devices with notes, pass src IP for one device |
| `set_device_note` | set or update a device memo by src IP; pass empty string to delete |

Time-window tools accept a `period` parameter: `1h`, `6h`, `24h` (default), `7d`, or `14d`.
`get_devices`, `get_device_notes`, and `set_device_note` do not use `period`.

---

## Option A — stdio (local, recommended)

Run the MCP server as a local process on the same machine as Claude Desktop. It makes REST API calls to your EgressView instance — which can be running locally or on a remote server.

This is the recommended approach for Claude Desktop. The `command`-based stdio transport is universally supported and avoids any URL validation restrictions.

**Prerequisites:** Node.js 22+, a running EgressView instance, API/admin token.

```bash
# 1. Clone (if not already):
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
```

**Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "egressview": {
      "command": "node",
      "args": ["/absolute/path/to/egressview/mcp-server.js"],
      "env": {
        "EGRESSVIEW_URL":   "http://your-server-ip:3000",
        "EGRESSVIEW_TOKEN": "your-admin-token"
      }
    }
  }
}
```

- Replace `/absolute/path/to/egressview` with the actual path where you cloned the repo.
- `EGRESSVIEW_URL` is the base URL of your EgressView server. If EgressView is behind a reverse proxy at `/egressview/`, use that path (e.g. `http://your-server-ip/egressview`).
- `EGRESSVIEW_TOKEN` is the API/admin token shown in the EgressView console on first startup, not the browser login password.

Restart Claude Desktop after editing. The `egressview` server appears in the MCP tools list.

---

## Option B — HTTP via reverse proxy (remote access)

Run `mcp-server.js` as an HTTP server on the same host as EgressView. A reverse proxy (Apache or nginx) exposes it externally.

> **Note for Claude Desktop users:** Claude Desktop currently requires `https://` URLs for remote MCP servers. If your reverse proxy does not terminate TLS, use Option A (stdio) instead — it works with both local and remote EgressView instances over plain HTTP.

This option is intended for MCP clients that natively support HTTP transport (Anysphere Cursor, Zed, AWS Kiro or Anthropic Claude with HTTP MCP config, custom agents).

### Connecting from ChatGPT

To use EgressView from ChatGPT, configure it separately in ChatGPT as a remote MCP server / app. Settings added to Codex (`~/.codex/config.toml`) or Claude Desktop (`claude_desktop_config.json`) are not shared with ChatGPT automatically.

Remote MCP servers used directly from ChatGPT generally need an HTTPS URL that ChatGPT can reach. If EgressView runs inside a home LAN, SOHO network, corporate network, or private subnet, do not expose the MCP endpoint directly to the public Internet without a deliberate access-control design. Consider OpenAI's Secure MCP Tunnel or an equivalent private connectivity pattern for private / behind-firewall MCP servers.

If you publish or share the integration as a ChatGPT App, also plan for per-user authentication and authorization. `X-Admin-Token` is enough for a personal proof of concept, but OAuth or another user-scoped authorization flow is more appropriate for multi-user or externally shared deployments. MCP tools can reveal network state and device notes, so only trusted clients and users should be allowed to call them.

### Step 1 — Start the MCP server on your EgressView host

```bash
# Copy and edit:
cp .env.mcp.example .env.mcp
# Set MCP_PORT=3010, MCP_TOKEN=<a dedicated random token>,
# MCP_SERVICE_TOKEN=<a scoped egv_... identity>,
# MCP_AUDIT_HMAC_KEY=<a dedicated 32+ character secret>,
# and EGRESSVIEW_URL=http://localhost:3000.
# If your EgressView service listens on a different local port behind a proxy,
# use that local URL instead (for example http://localhost:3002).
chmod 600 .env.mcp

# Test run:
set -a; source .env.mcp; set +a
node mcp-server.js
# → [egressview-mcp] HTTP transport listening on 127.0.0.1:3010/mcp
```

HTTP token mode requires three distinct credentials: `MCP_TOKEN` authenticates
the MCP client, `MCP_SERVICE_TOKEN` is an `egv_...` API identity with exactly
`network.read` and `notes.write`, and `MCP_AUDIT_HMAC_KEY` pseudonymises the
append-only audit trail. None may equal `EGRESSVIEW_TOKEN` or each other.
HTTP mode never uses the browser/admin token for runtime API calls. Stdio mode
is unchanged.

### Staged OAuth Resource Server mode

P2-60's OAuth Resource Server boundary can be enabled for private integration
testing with `MCP_AUTH_MODE=oauth`,
`MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE`, `MCP_OAUTH_READ_SCOPE`,
`MCP_OAUTH_NOTES_WRITE_SCOPE`, `MCP_SERVICE_TOKEN`, and
`MCP_AUDIT_HMAC_KEY`.
It publishes RFC 9728 Protected Resource Metadata, validates RS256 JWT
signatures through the issuer's discovery/JWKS endpoints, and fails closed on
issuer, expiry, audience, or scope mismatches. The issuer must advertise PKCE
S256. HTTPS is required except for loopback-only testing.

The default `MCP_OAUTH_COMPATIBILITY_PROFILE=strict` keeps that metadata check.
For an exact AWS Cognito regional user-pool issuer only, setting the profile to
`cognito` permits an omitted `code_challenge_methods_supported` field. It does
not permit contradictory metadata and does not relax signature, issuer,
expiry, single-audience, or scope checks. Do not enable this profile until the
pre-publication evidence proves PKCE S256 on the wire, both RFC 8707 resource
parameters, the exact callback, refresh rotation, and revocation with each
supported client version.

External provider scopes map to EgressView's shared permissions:
`MCP_OAUTH_READ_SCOPE` grants `network.read`, while
`MCP_OAUTH_NOTES_WRITE_SCOPE` grants `notes.write`. A read-only access token
does not list `set_device_note`; a direct call is rejected with `403
insufficient_scope`. The write challenge includes both scopes so a step-up
authorization does not discard the already granted read scope.

Both HTTP token and OAuth modes require a dedicated API identity with exactly
`network.read` and `notes.write`. Place its one-time plaintext token in
`MCP_SERVICE_TOKEN`:

```bash
curl -sS -X POST http://127.0.0.1:3002/api/auth/api-identities \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"label":"Remote MCP service","permissions":["network.read","notes.write"],"expiresInMs":31536000000}'
```

OAuth mode accepts only an `egv_...` scoped identity and never falls back to
`EGRESSVIEW_TOKEN`. Store `.env.mcp` with mode `0600`, rotate the identity
before expiry, and revoke the previous identity after validation. Generate the
audit key once with `openssl rand -hex 32` and keep it unchanged when rotating
the service identity. The Internet publication gate is delivered by the next
P2-60 phase. Do not publish this endpoint to the Internet yet.

### Step 2a — Apache (httpd) config

Add inside your existing `<VirtualHost>` or server config. The MCP block **must come before** the general `/egressview/` ProxyPass rule.

```apache
# ─── EgressView MCP Server ────────────────────────────────────────────────────
<Location /egressview/mcp>
    ProxyPass        http://127.0.0.1:3010/mcp flushpackets=on
    ProxyPassReverse http://127.0.0.1:3010/mcp
    # MCP Streamable HTTP requires both content types in Accept
    RequestHeader set Accept "application/json, text/event-stream"
</Location>

# OAuth mode only: expose RFC 9728 metadata while preserving its path.
ProxyPass        /.well-known/oauth-protected-resource http://127.0.0.1:3010/.well-known/oauth-protected-resource
ProxyPassReverse /.well-known/oauth-protected-resource http://127.0.0.1:3010/.well-known/oauth-protected-resource

# ─── EgressView Web UI (existing rule — keep below) ──────────────────────────
ProxyPass        /egressview/ http://127.0.0.1:3002/
ProxyPassReverse /egressview/ http://127.0.0.1:3002/
```

Required Apache modules: `mod_proxy`, `mod_proxy_http`, `mod_headers` (usually enabled by default).

```bash
sudo apachectl configtest && sudo systemctl reload httpd
```

### Step 2b — nginx config

Add inside your `server {}` block:

```nginx
location /egressview/mcp {
    proxy_pass         http://127.0.0.1:3010/mcp;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-Proto $scheme;
    # Required for Server-Sent Events (streaming responses)
    proxy_set_header   Accept            "application/json, text/event-stream";
    proxy_set_header   Connection        '';
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 3600s;
}

# OAuth mode only: preserve root and resource-specific metadata paths.
location /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:3010;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Step 3 — Run as a systemd service (optional but recommended)

```ini
# /etc/systemd/system/egressview-mcp.service
[Unit]
Description=EgressView MCP Server
After=network.target egressview.service

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/egressview
EnvironmentFile=/home/ec2-user/egressview/.env.mcp
ExecStart=/usr/bin/node /home/ec2-user/egressview/mcp-server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now egressview-mcp
```

### Step 4 — Client config (HTTP mode)

For MCP clients that support HTTP transport (Anysphere Cursor, Zed, custom agents):

```json
{
  "mcpServers": {
    "egressview": {
      "url": "https://your-server/egressview/mcp",
      "headers": {
        "X-Admin-Token": "your-dedicated-mcp-token"
      }
    }
  }
}
```

Use `https://` if your reverse proxy terminates TLS (required for Claude Desktop). For plain `http://`, use Option A (stdio) from Claude Desktop instead.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `EGRESSVIEW_DEPLOYMENT_PROFILE` | Recommended | Inferred | `local-stdio`, `private-http`, `private-oauth`, or `public-oauth`; see the deployment-profile matrix. |
| `EGRESSVIEW_URL` | ✅ | `http://localhost:3000` | Base URL of the EgressView server |
| `EGRESSVIEW_TOKEN` | stdio/setup | — | API/admin token used by stdio compatibility or to create the HTTP service identity; HTTP runtime calls use `MCP_SERVICE_TOKEN`. |
| `MCP_PORT` | HTTP mode | — | Local port for the MCP HTTP server (e.g. `3010`). Omit for stdio mode. |
| `MCP_BIND_ADDRESS` | HTTP mode | `127.0.0.1` | Literal IPv4/IPv6 bind address. Hostnames are rejected. |
| `MCP_ALLOW_NON_LOOPBACK` | Non-loopback bind | `false` | Must be exactly `true`, together with an explicit deployment profile, before a LAN/container/all-interface bind is allowed. |
| `MCP_AUTH_MODE` | HTTP mode | `token` | HTTP endpoint authentication mode: `token` or staged `oauth`. |
| `MCP_TOKEN` | HTTP token mode | — | Dedicated private HTTP endpoint token. It must be set explicitly and must differ from `EGRESSVIEW_TOKEN`. |
| `MCP_OAUTH_ISSUER` | HTTP OAuth mode | — | Exact HTTPS authorization-server issuer URL. Loopback HTTP is allowed only for testing. |
| `MCP_OAUTH_COMPATIBILITY_PROFILE` | HTTP OAuth mode | `strict` | `strict`, or `cognito` for an exact AWS Cognito regional user-pool issuer with completed compatibility evidence. |
| `MCP_OAUTH_RESOURCE` | HTTP OAuth mode | — | Canonical public MCP resource URL used for exact JWT audience validation. |
| `MCP_OAUTH_READ_SCOPE` | HTTP OAuth mode | — | Provider scope mapped to the internal `network.read` permission. |
| `MCP_OAUTH_NOTES_WRITE_SCOPE` | HTTP OAuth mode | — | Provider scope mapped to the internal `notes.write` permission. |
| `MCP_SERVICE_TOKEN` | HTTP mode | — | Dedicated `egv_...` API identity token with exactly `network.read` and `notes.write`. |
| `MCP_AUDIT_HMAC_KEY` | HTTP mode | — | Stable secret of at least 32 characters used only to pseudonymise audit subjects and clients. |

---

## Security Notes

- The MCP HTTP server listens on `127.0.0.1` by default. A non-loopback literal IP requires both an explicit profile and `MCP_ALLOW_NON_LOOPBACK=true`; protect that path with TLS and network policy.
- Private token mode accepts the dedicated `MCP_TOKEN` through `X-Admin-Token` or `Authorization: Bearer`; it never falls back to the EgressView admin token.
- Every HTTP mode uses the same fail-closed audit, rate/concurrency limits, body bounds, deadlines, and least-privilege service identity.
- Most tools are read-only. `set_device_note` can write device memo notes (stored in `.egressview.notes.json`, not the main database).
- Keep `.env.mcp` permissions at `chmod 600`; it contains private API credentials.

---

## HTTP MCP: limits, audit and revocation

The runtime limits and audit controls apply to both private token and OAuth
HTTP modes. Stdio mode is unaffected. OAuth provides per-user/per-client
identity; private token mode records and limits the shared private credential.

### Request limits

Three independent buckets apply, and all must allow a request. A separate concurrency cap bounds in-flight work, because slow tool calls exhaust the process long before a per-minute limit trips.

| Setting | Default | Purpose |
|---|---|---|
| `MCP_RATE_LIMIT_GLOBAL` | 60/min | Protects the host from any single burst |
| `MCP_RATE_LIMIT_SUBJECT` | 30/min | One compromised user cannot consume the whole budget |
| `MCP_RATE_LIMIT_CLIENT` | 30/min | One misbehaving client cannot either |
| `MCP_MAX_CONCURRENT` | 4 | Bounds simultaneous tool calls |
| `MCP_MAX_BODY` | `256kb` | Body is bounded before parsing or authentication |
| `MCP_REQUEST_TIMEOUT_MS` | 30000 | Deadline for one MCP exchange |
| `MCP_API_TIMEOUT_MS` | 15000 | Deadline for one internal EgressView API call |

Without a deadline, `MCP_MAX_CONCURRENT` stalled calls would hold every slot and wedge the endpoint closed. The request deadline aborts the internal API call and ends the response. Note that the MCP transport streams: once it has begun a response the status can no longer become `504`, so a call that blows its deadline mid-stream is recorded as `request_timeout` in the audit rather than reported by status code. Timeout values must be whole milliseconds from 1 through 600000; invalid values fall back to the documented defaults.

The defaults are deliberately tight: there is no measured usage to size them from yet, and loosening one after a false positive is cheap, while discovering one was too loose only happens after abuse. Raise them if a legitimate workload trips a limit.

A rejected request returns `429` with `Retry-After`. Values that are not positive integers fall back to the default rather than disabling the limit — a typo cannot silently remove a bound.

**Keep the reverse proxy's own limits as well.** These are the Node-side half; a bug or restart here must not leave the endpoint unbounded. Trust `X-Forwarded-For` only from the proxy addresses listed in `EGRESSVIEW_TRUST_PROXY` (see the [authentication guide](authentication.md)).

### Audit

Every HTTP request is appended to a dedicated store (`MCP_AUDIT_DB_PATH`, default `.egressview-mcp-audit.db`). The HTTP endpoint fails to start if this store cannot be verified writable. It is **separate from EgressView's own audit trail on purpose**: the MCP process runs with a scoped API identity, and giving it write access to the main trail would let a compromised MCP forge or tamper with those records.

Recorded: pseudonymised OAuth subject and client id, tool name, granted scopes, outcome, a reason code, the request id, and duration.

**Never recorded:** tool arguments, IP or MAC addresses, device note bodies, access tokens, raw JWTs, or provider error text.

**Joining the two trails.** EgressView audits what the MCP service identity did (`actor: api:<id>`); this store records which OAuth subject asked for it. The MCP request id is forwarded to EgressView as `X-Request-Id`, so one incident can be followed across both. Keep the two retention windows equal, or the record of *who asked* will expire while the record of *what happened* remains.

Reason codes: `unauthorized`, `invalid_token`, `insufficient_scope`, `bad_request`, `not_found`, `method_not_allowed`, `payload_too_large`, `client_error`, `tool_error`, `global_rate_limit`, `subject_rate_limit`, `client_rate_limit`, `concurrency_limit`, `request_timeout`, `server_error`. Request-level rows also record the bounded MCP method and HTTP status. Tool calls are recorded when the handler completes rather than when a long-lived response stream closes. Tool arguments, response bodies, and provider error text are never stored. A run of failures is the signal to investigate.

Subjects are pseudonymised with the dedicated `MCP_AUDIT_HMAC_KEY`, so the same person correlates across requests without the identifier being stored. Keep this key stable when rotating `MCP_SERVICE_TOKEN`; changing it intentionally starts a new pseudonym namespace. Entries older than 180 days are pruned at startup, matching EgressView's own audit retention.

### Revoking access

1. **Revoke at the authorization server** — this is the only place that stops new tokens being issued. Revoke the user, or the client registration, depending on what went wrong.
2. **Wait out the access token lifetime.** EgressView validates tokens offline, so a token already issued stays valid until it expires. Keep access token lifetime short (5–15 minutes is the working assumption) precisely so this window is small.
3. **To cut access immediately**, stop the public endpoint: remove the proxy route or set `MCP_AUTH_MODE=token`. Local collection, the browser UI, stdio and private HTTP keep running.
4. **Rotate `MCP_SERVICE_TOKEN`** if the MCP host itself may be compromised. Issue a new scoped API identity in EgressView, update `.env.mcp`, restart, then revoke the old identity.

### If the authorization server or JWKS is unreachable

The public MCP endpoint fails closed and returns `401`. Everything else keeps running: router collection, the browser UI, stdio clients and private HTTP mode. Do not treat an IdP outage as an EgressView outage.

## Pre-publication gate

P2-60 provides a fail-closed gate that must pass before a public DNS record is
created. The gate **does not create or modify DNS, certificates, load
balancers, security groups, Keycloak, or EgressView configuration**. A passing
result is only `ready_for_manual_dns_review`; publishing DNS remains a separate
reviewed operation.

Run it against the DNS-unpublished ALB or reverse proxy. The canonical hostname
is retained for TLS SNI and the HTTP `Host` header, while
`MCP_GATE_CONNECT_ADDRESS` pins the staged target like `curl --connect-to`.

```bash
cp .env.mcp-gate.example .env.mcp-gate
chmod 600 .env.mcp-gate
cp docs/mcp-publication-evidence.example.json \
  .egressview-mcp-publication-evidence.json

set -a
. ./.env.mcp-gate
set +a
npm run mcp:publication-gate
```

Both local files are gitignored. Keep bearer tokens only in the mode-`0600`
environment file and remove them immediately after the run. The evidence JSON
and generated report contain no token values, tool arguments, network
observations, IP/MAC addresses, or credentials.

The dual-era gate requires evidence schema v3. Replace an older template rather
than editing its version number alone; the client protocol and compatibility
fields are mandatory and must come from actual client runs.

### Required evidence

Every evidence item must be successful, refer to the exact deployed
40-character Git commit, and be no more than 30 days old:

- production DNS is still disabled and EC2 has no direct Internet ingress to
  ports 443, 3000, 3002, or 3010;
- reverse-proxy body, request-rate, concurrency, and timeout limits were
  exercised;
- staged application rollback and MCP service-identity rotation were tested;
- provider recovery evidence passed: restore the Keycloak database into a
  disposable environment in strict mode; Cognito mode instead requires the
  provider-specific compatibility evidence below;
- with Keycloak/JWKS unavailable and the MCP JWKS cache cold, public MCP failed
  closed while `/healthz`, `/readyz`, and current router collection remained
  healthy;
- refresh-token replay protection passed in one documented mode: either the
  replay request was rejected while the current family remained usable
  (`reject-replay`), or replay detection revoked the complete family and the
  current refresh token was then rejected (`revoke-family`);
- the access-token lifetime was recorded and was no more than 15 minutes, which
  bounds a token minted before family revocation takes effect;
- Claude Code completed read-tool and refresh tests against the staged endpoint
  and recorded either supported protocol revision. The active gate probes both
  `2025-11-25` and `2026-07-28` independently of product release timing;
- GitHub Copilot CLI completed the same tests in strict mode. Cognito mode may
  instead record `unsupported-random-loopback-port` when the tested release
  cannot use a fixed callback accepted by Cognito;
- one retained legacy client completed the same tool-discovery check with
  `2025-11-25`.

With `MCP_GATE_OAUTH_COMPATIBILITY_PROFILE=cognito`, the gate additionally
requires `cognitoCompatibility` evidence matching the configured issuer and
resource. It must record PKCE `S256`, `resource` in both authorization and
token requests, the access-token audience and refreshed audience, exact
callback matching for tested compatible clients, old-refresh-token and
post-revocation rejection, and the tested Inspector, Claude Code, and Copilot
CLI versions. A Cognito callback
limitation must be recorded explicitly and does not claim Copilot
compatibility. The Keycloak database restore entry is not required in this
profile.

The JWKS outage test must use a cold MCP process. A running process may
legitimately continue validating signatures with a still-valid cached JWKS;
that is not evidence that discovery fails closed.

### Active probes

The command then verifies:

- the public hostname has no A or AAAA record;
- TLS hostname verification and both RFC 9728 metadata paths;
- scope-bearing `401` challenges for unauthenticated calls;
- successful `2025-11-25` `initialize` and `2026-07-28` `server/discover`;
- the same 11-tool inventory through both protocol revisions;
- modern header/body mismatch error `-32020` and unsupported-version error
  `-32022`;
- rejection of malformed, expired, wrong-audience, and revoked-then-expired
  access tokens, after independently verifying the fixture signatures against
  the configured issuer's JWKS;
- a real read tool through the scoped internal service identity;
- `403` for a read token attempting `set_device_note`, and visibility of that
  tool with a write-scoped token;
- `429` plus `Retry-After` after the configured staging burst;
- corresponding append-only audit rows and pseudonymized identity fields;
- local readiness and recent successful collection from every enabled router.

The rate probe intentionally fills the staging process's global one-minute
bucket. Do not run it against a live public endpoint.

Because EgressView validates JWTs offline, revoking a Keycloak session or
refresh family does not invalidate an already-issued access token before its
`exp`. `MCP_GATE_REVOKED_EXPIRED_TOKEN` is therefore checked after the short
access-token TTL expires. Evidence mode `reject-replay` requires the replay
request itself to fail while the current family remains usable. Mode
`revoke-family`, matching the observed Keycloak 26.7.0 behavior, requires the
current family to fail after replay detection; the replay request may have
minted one final short-lived access token. Both modes require an access-token
lifetime of at most 15 minutes. For immediate containment, remove the public
proxy route first; do not claim immediate access-token revocation.

### Result and rollback

A successful run writes a mode-`0600`
`.egressview-mcp-publication-gate.json`. It records the deployed commit,
timestamp, hostname, router count, and pass/fail categories, but no secrets.
Failure exits nonzero and must block DNS publication.

If any post-publication check fails, remove the Web/MCP DNS aliases, disable the
MCP proxy route, and return to VPN/SSM access. Restore the last verified
application release and Keycloak database only through their separately tested
rollback procedures. Router collection and the local recovery administrator
must remain available throughout.

## Trademarks

AWS Kiro, Anthropic Claude, Anysphere Cursor, and other product names are trademarks or registered trademarks of their respective owners. EgressView is not affiliated with, endorsed by, or sponsored by those companies.
