# AI Agent Access via MCP

EgressView exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI assistants — including AWS Kiro, Anthropic Claude, Anysphere Cursor, Zed, and any MCP-compatible agent — query your network data directly.

> 🇯🇵 [日本語版はこちら](setup-mcp.ja.md)

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
# EGRESSVIEW_URL=http://localhost:3000, EGRESSVIEW_TOKEN=...
# If your EgressView service listens on a different local port behind a proxy,
# use that local URL instead (for example http://localhost:3002).
chmod 600 .env.mcp

# Test run:
set -a; source .env.mcp; set +a
node mcp-server.js
# → [egressview-mcp] HTTP transport listening on 127.0.0.1:3010/mcp
```

`MCP_TOKEN` is now required explicitly in HTTP token mode and no longer
defaults to `EGRESSVIEW_TOKEN`. This prevents a leaked MCP endpoint token from
also granting full EgressView admin API access. Existing HTTP installations
that relied on the old fallback must generate a separate token and set
`MCP_TOKEN` before upgrading. Stdio mode is unchanged and does not use
`MCP_TOKEN`.

### Staged OAuth Resource Server mode

P2-60's OAuth Resource Server boundary can be enabled for private integration
testing with `MCP_AUTH_MODE=oauth`,
`MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE`, `MCP_OAUTH_READ_SCOPE`,
`MCP_OAUTH_NOTES_WRITE_SCOPE`, and `MCP_SERVICE_TOKEN`.
It publishes RFC 9728 Protected Resource Metadata, validates RS256 JWT
signatures through the issuer's discovery/JWKS endpoints, and fails closed on
issuer, expiry, audience, or scope mismatches. The issuer must advertise PKCE
S256. HTTPS is required except for loopback-only testing.

External provider scopes map to EgressView's shared permissions:
`MCP_OAUTH_READ_SCOPE` grants `network.read`, while
`MCP_OAUTH_NOTES_WRITE_SCOPE` grants `notes.write`. A read-only access token
does not list `set_device_note`; a direct call is rejected with `403
insufficient_scope`. The write challenge includes both scopes so a step-up
authorization does not discard the already granted read scope.

Create a dedicated API identity with exactly `network.read` and `notes.write`,
then place its one-time plaintext token in `MCP_SERVICE_TOKEN`:

```bash
curl -sS -X POST http://127.0.0.1:3002/api/auth/api-identities \
  -H "X-Admin-Token: $EGRESSVIEW_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"label":"Remote MCP service","permissions":["network.read","notes.write"],"expiresInMs":31536000000}'
```

OAuth mode accepts only an `egv_...` scoped identity and never falls back to
`EGRESSVIEW_TOKEN`. Store `.env.mcp` with mode `0600`, rotate the identity
before expiry, and revoke the previous identity after validation. OAuth
audit/rate limits and the Internet publication gate are delivered by later
P2-60 phases. Do not publish this endpoint to the Internet yet.

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
| `EGRESSVIEW_URL` | ✅ | `http://localhost:3000` | Base URL of the EgressView server |
| `EGRESSVIEW_TOKEN` | ✅ | — | API/admin token (shown on first EgressView startup; not the browser login password) |
| `MCP_PORT` | HTTP mode | — | Local port for the MCP HTTP server (e.g. `3010`). Omit for stdio mode. |
| `MCP_AUTH_MODE` | HTTP mode | `token` | HTTP endpoint authentication mode: `token` or staged `oauth`. |
| `MCP_TOKEN` | HTTP token mode | — | Dedicated private HTTP endpoint token. It must be set explicitly and must differ from `EGRESSVIEW_TOKEN`. |
| `MCP_OAUTH_ISSUER` | HTTP OAuth mode | — | Exact HTTPS authorization-server issuer URL. Loopback HTTP is allowed only for testing. |
| `MCP_OAUTH_RESOURCE` | HTTP OAuth mode | — | Canonical public MCP resource URL used for exact JWT audience validation. |
| `MCP_OAUTH_READ_SCOPE` | HTTP OAuth mode | — | Provider scope mapped to the internal `network.read` permission. |
| `MCP_OAUTH_NOTES_WRITE_SCOPE` | HTTP OAuth mode | — | Provider scope mapped to the internal `notes.write` permission. |
| `MCP_SERVICE_TOKEN` | HTTP OAuth mode | — | Dedicated `egv_...` API identity token with exactly `network.read` and `notes.write`. |

---

## Security Notes

- The MCP HTTP server listens on `127.0.0.1` only — it is not reachable without the reverse proxy.
- Private token mode accepts the dedicated `MCP_TOKEN` through `X-Admin-Token` or `Authorization: Bearer`; it never falls back to the EgressView admin token.
- Most tools are read-only. `set_device_note` can write device memo notes (stored in `.egressview.notes.json`, not the main database).
- Keep `.env.mcp` permissions at `chmod 600`; it contains private API credentials.

---

## Public MCP: limits, audit and revocation

Applies to OAuth mode (`MCP_AUTH_MODE=oauth`) only. Private token and stdio modes are unaffected by everything in this section.

### Request limits

Three independent buckets apply, and all must allow a request. A separate concurrency cap bounds in-flight work, because slow tool calls exhaust the process long before a per-minute limit trips.

| Setting | Default | Purpose |
|---|---|---|
| `MCP_RATE_LIMIT_GLOBAL` | 60/min | Protects the host from any single burst |
| `MCP_RATE_LIMIT_SUBJECT` | 30/min | One compromised user cannot consume the whole budget |
| `MCP_RATE_LIMIT_CLIENT` | 30/min | One misbehaving client cannot either |
| `MCP_MAX_CONCURRENT` | 4 | Bounds simultaneous tool calls |
| `MCP_MAX_BODY` | `256kb` | Body is bounded before parsing or authentication |

The defaults are deliberately tight: there is no measured usage to size them from yet, and loosening one after a false positive is cheap, while discovering one was too loose only happens after abuse. Raise them if a legitimate workload trips a limit.

A rejected request returns `429` with `Retry-After`. Values that are not positive integers fall back to the default rather than disabling the limit — a typo cannot silently remove a bound.

**Keep the reverse proxy's own limits as well.** These are the Node-side half; a bug or restart here must not leave the endpoint unbounded. Trust `X-Forwarded-For` only from the proxy addresses listed in `EGRESSVIEW_TRUST_PROXY` (see the [authentication guide](authentication.md)).

### Audit

Every request to the public endpoint is appended to a dedicated store (`MCP_AUDIT_DB_PATH`, default `.egressview-mcp-audit.db`). It is **separate from EgressView's own audit trail on purpose**: the MCP process runs with a scoped API identity, and giving it write access to the main trail would let a compromised MCP forge or tamper with those records.

Recorded: pseudonymised OAuth subject and client id, tool name, granted scopes, outcome, a reason code, the request id, and duration.

**Never recorded:** tool arguments, IP or MAC addresses, device note bodies, access tokens, raw JWTs, or provider error text.

**Joining the two trails.** EgressView audits what the MCP service identity did (`actor: api:<id>`); this store records which OAuth subject asked for it. The MCP request id is forwarded to EgressView as `X-Request-Id`, so one incident can be followed across both. Keep the two retention windows equal, or the record of *who asked* will expire while the record of *what happened* remains.

Reason codes: `unauthorized`, `invalid_token`, `insufficient_scope`, `global_rate_limit`, `subject_rate_limit`, `client_rate_limit`, `concurrency_limit`, `server_error`. A run of any of these is the signal to investigate.

Subjects are pseudonymised with a keyed HMAC, so the same person correlates across requests without the identifier being stored. Entries older than 180 days are pruned at startup, matching EgressView's own audit retention.

### Revoking access

1. **Revoke at the authorization server** — this is the only place that stops new tokens being issued. Revoke the user, or the client registration, depending on what went wrong.
2. **Wait out the access token lifetime.** EgressView validates tokens offline, so a token already issued stays valid until it expires. Keep access token lifetime short (5–15 minutes is the working assumption) precisely so this window is small.
3. **To cut access immediately**, stop the public endpoint: remove the proxy route or set `MCP_AUTH_MODE=token`. Local collection, the browser UI, stdio and private HTTP keep running.
4. **Rotate `MCP_SERVICE_TOKEN`** if the MCP host itself may be compromised. Issue a new scoped API identity in EgressView, update `.env.mcp`, restart, then revoke the old identity.

### If the authorization server or JWKS is unreachable

The public MCP endpoint fails closed and returns `401`. Everything else keeps running: router collection, the browser UI, stdio clients and private HTTP mode. Do not treat an IdP outage as an EgressView outage.

## Trademarks

AWS Kiro, Anthropic Claude, Anysphere Cursor, and other product names are trademarks or registered trademarks of their respective owners. EgressView is not affiliated with, endorsed by, or sponsored by those companies.
