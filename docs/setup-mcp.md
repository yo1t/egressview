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

**Prerequisites:** Node.js 18+, a running EgressView instance, API/admin token.

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

### Step 1 — Start the MCP server on your EgressView host

```bash
# Copy and edit:
cp .env.mcp.example .env.mcp
# Set MCP_PORT=3010, EGRESSVIEW_URL=http://localhost:3000, EGRESSVIEW_TOKEN=...
# If your EgressView service listens on a different local port behind a proxy,
# use that local URL instead (for example http://localhost:3002).
chmod 600 .env.mcp

# Test run:
set -a; source .env.mcp; set +a
node mcp-server.js
# → [egressview-mcp] HTTP transport listening on 127.0.0.1:3010/mcp
```

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
        "X-Admin-Token": "your-admin-token"
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
| `MCP_TOKEN` | — | same as `EGRESSVIEW_TOKEN` | Auth token for the MCP HTTP endpoint. Set to a different value to separate MCP and EgressView auth. |

---

## Security Notes

- The MCP HTTP server listens on `127.0.0.1` only — it is not reachable without the reverse proxy.
- Authentication uses the `X-Admin-Token` header (same mechanism as the EgressView API).
- Most tools are read-only. `set_device_note` can write device memo notes (stored in `.egressview.notes.json`, not the main database).
- Keep `.env.mcp` permissions at `chmod 600`; it contains your API/admin token.

## Trademarks

AWS Kiro, Anthropic Claude, Anysphere Cursor, and other product names are trademarks or registered trademarks of their respective owners. EgressView is not affiliated with, endorsed by, or sponsored by those companies.
