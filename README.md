# EgressView

**Home / SOHO Network Security Monitor — Real-time visibility into every LAN device's outbound connections**

Is your smart TV phoning home to unexpected servers? Are your IP cameras, IoT appliances, or NAS boxes making connections you never authorised? EgressView answers these questions by passively monitoring every outbound connection from every device on your LAN, then turning that data into an investigation workflow: Graph Map and Statistics for the big picture, Connection Log and Devices for drill-down analysis — with automatic threat detection.

No new hardware. No inline traffic interception. Works via your existing Yamaha RTX router's NAT session table.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

> 🇯🇵 [日本語版 README はこちら](README.ja.md) | 🌐 [Project Page](https://yo1t.github.io/egressview/)

---

## Project Status

EgressView is production-oriented for Yamaha RTX based home/SOHO networks. ASUS AP support and optional data sources are maintained as companion integrations. Other router families are tracked on the roadmap. Security fixes are applied to `main`; run `npm run release:check` before publishing or tagging a release.

## For Home / SOHO Security

Modern home and SOHO networks run 20–40 devices: smart TVs, IP cameras, NAS drives, Wi-Fi speakers, printers, network switches, PCs, and smartphones. Many of these — especially IoT equipment — update infrequently and have unknown outbound behaviors. Any of them can be silently compromised and begin exfiltrating data or relaying traffic for a botnet.

EgressView answers the question most home users can't ask: *what is each device on my network actually connecting to?*

- **Passive, zero-impact monitoring** — reads the router's NAT session table over SSH; no inline tap, no throughput penalty, no latency added
- **Per-device visibility** — every connection tagged to the source device (vendor, model, hostname) via OUI, mDNS, SSDP, and NetBIOS
- **Automatic threat detection** — every connection checked in real time against Feodo Tracker, ThreatFox, URLhaus, and Spamhaus DROP
- **Instant Slack alerts** — DM the moment any device connects to a known C2 server or malware distribution host
- **No hardware changes** — runs on any Mac, PC, or Raspberry Pi alongside your existing Yamaha RTX router

## What it does

- Connects to a **Yamaha RTX** router via SSH and reads the NAT session table every 60 seconds
- **[INSPECT] syslog supplement** — tails the Yamaha syslog in real time to capture short-lived TCP sessions that complete within the 60-second polling gap
- **dnsmasq DNS query log** — tails the EC2/server-side dnsmasq log to resolve destination IPs to meaningful domain names (e.g. `example.com`) per client device; forward DNS names take priority over PTR reverse lookups
- **[DHCPD] syslog tracking** — tails Yamaha DHCP events (Allocates/Extends) for real-time IP→MAC mapping
- **Threat intelligence**: matches all connections against Feodo Tracker, ThreatFox, URLhaus, and Spamhaus DROP feeds (auto-refreshed hourly)
- **Slack notifications**: sends a DM when a threat is detected (configurable cooldown, language-aware)
- Identifies local devices using **OUI vendor lookup**, **mDNS/Bonjour**, **SSDP**, **NetBIOS**, and an **Apple model dictionary** (resolves down to "iPhone 15 Pro")
- Enriches each destination IP with **reverse DNS**, **RDAP** (organization name), and **GeoIP** (latitude/longitude/city)
- Uses **Graph Map** and **Statistics** for whole-network overview, then **Connection Log** and **Devices** for per-session and per-device drill-down
- Optionally connects to an **ASUS WiFi access point** (used as AP/mesh, not as a router) to get WiFi client details (band, signal strength, traffic rates, AiMesh topology)
- Keeps a **connection history** in **SQLite** (WAL mode, crash-safe; configurable retention up to 2 years)
- **Connection log**: sortable/searchable table of all sessions with threat status badges; **App column** infers the application or service name from port number and destination hostname (APNs, FCM, AirPlay, MQTT/TLS, QUIC, iCloud, YouTube, AWS, Slack, Zoom, Tuya Smart, Gaijin/DCS, and more)
- **🔔 Detection Log** — persistent history of all threat detections and new-device alerts, with per-column filter, sort, and click-to-detail popup; logged regardless of Slack configuration
- **📡 Data Sources tab** — configure each data source (dnsmasq / [INSPECT] / [DHCPD]) independently from the settings UI
- Single-page dark-themed UI: Graph Map, Statistics, Connection Log, Devices, Detection Log, and Settings

## Demo

https://github.com/user-attachments/assets/8682ec5f-1632-400f-b31b-d371f6b1b237

> UI language: English / Japanese selectable

Graph Map and Statistics give you the network-wide overview: device/destination patterns, session trends, and noisy endpoints — all updating in real time.

Connection Log and Devices let you drill down into suspicious destinations, noisy devices, beacon candidates, notes, and device history: see the pattern, filter the time range, inspect sessions, then pivot to the device.

## Screenshots

![Graph Map overview](docs/egressview1.png)
![Statistics view](docs/egressview2.png)
![Connection Log drill-down](docs/egressview3.png)
![Devices drill-down](docs/egressview4.png)

## Architecture

```
┌─────────────────┐  SSH (NAT)  ┌──────────────────────┐
│  Yamaha RTX     │◄───────────►│                      │
│  [INSPECT] log  │  syslog/UDP │   EgressView Server     │  WebSocket
│  [DHCPD] log    │────────────►│   (Node.js)          │◄──────────► Browser
└─────────────────┘             │                      │
┌─────────────────┐  HTTP       │  Pollers:            │
│  ASUS WiFi AP   │◄───────────►│  • yamaha (SSH)      │
│  (Client list)  │             │  • asus (HTTP)       │
└─────────────────┘             │  • inspect-syslog    │
┌─────────────────┐  tail -F    │  • dhcpd-syslog      │
│  dnsmasq        │────────────►│  • dnsmasq-log       │
│  query log      │             └──────────┬───────────┘
└─────────────────┘                        │
                       ┌───────────────────┼───────────────┐
                       │                   │               │
                 ┌─────┴─────┐  ┌─────────┴───┐  ┌───────┴───┐
                 │ Enrichment│  │  Threat Intel│  │  SQLite   │
                 │ • dnsmasq │  │  • Feodo     │  │  History  │
                 │ • Rev DNS │  │  • ThreatFox │  │  (WAL)    │
                 │ • RDAP    │  │  • URLhaus   │  └───────────┘
                 │ • GeoIP   │  │  • DROP      │
                 │ • OUI     │  └─────────────┘
                 │ • mDNS    │
                 └───────────┘
```

## Requirements

- **Node.js** 18+
- **Yamaha RTX** router with SSH access enabled (RTX1200, RTX1210, RTX1220, RTX1300, etc.)
- (Optional) **ASUS WiFi access point** with web admin enabled (used as AP/mesh mode, not as a router)

## AI Agent Access (MCP)

EgressView exposes a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server so Claude Desktop, Claude Code, and other AI assistants can query your network data directly — just ask in natural language.

```
"Show me a threat summary for the last 24 hours"
"Any new devices on the network this week?"
"What is 192.168.1.50 connecting to?"
"Are there any threat connections right now?"
"Add a note to 192.168.1.97: Roomba, connects to GitHub for OTA updates"
```

**Quick setup** (Claude Desktop, macOS): add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "egressview": {
      "command": "node",
      "args": ["/path/to/egressview/mcp-server.js"],
      "env": {
        "EGRESSVIEW_URL":   "http://your-server-ip:3002",
        "EGRESSVIEW_TOKEN": "your-admin-token"
      }
    }
  }
}
```

11 tools available: `get_threat_summary`, `get_traffic_summary`, `get_top_destinations`, `get_device_traffic`, `get_new_nodes`, `get_threat_connections`, `get_alerts`, `get_devices`, `query_connections`, `get_device_notes`, `set_device_note`.

See the **[MCP setup guide →](docs/setup-mcp.md)** for full instructions including remote EgressView access and HTTP mode behind Apache / nginx.

---

## Try Without Hardware

Want to explore the UI before setting up a router? Start in **demo mode** — it seeds 160 realistic sample connections and uses a fixed admin token:

```bash
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
DEMO_MODE=true DEMO_ADMIN_TOKEN=my-token npm start
```

Open `http://localhost:3000` and enter `my-token` when prompted. All views — Graph Map, Statistics, Connection Log, Devices — are fully functional with the sample data. A **DEMO** badge appears in the header to distinguish it from a live installation.

---

## Quick Start

### Choose the shortest setup path

Start with the smallest path that matches your network, then add sources later from Settings.

| Pattern | Use this when | What to configure first |
|---------|---------------|-------------------------|
| Minimal: Yamaha RTX only | You want the fastest first run with no extra hardware | Yamaha IP, SSH username, SSH password, then **Connect & Auto-detect** |
| Recommended: Yamaha RTX + ASUS AP | You also want WiFi client names, vendors, and MAC visibility | Minimal setup, then ASUS AP IP and admin login |
| Detailed: + dnsmasq / INSPECT / DHCPD | You want richer hostnames, short-lived TCP sessions, and live IP-to-MAC mapping | Recommended setup, then enable Data Sources |
| Notifications: + Slack | You want threat detections delivered by DM | Any setup above, then Slack notifications |

### Step 1 — Prerequisites checklist

| | Requirement | Setup guide |
|--|-------------|-------------|
| ✅ | Node.js 18+ installed on your Mac/PC/Raspberry Pi | [nodejs.org](https://nodejs.org) |
| ✅ | Yamaha RTX router with SSH enabled | [Setup guide →](docs/setup-yamaha.md) |
| ☐ | (Optional) ASUS WiFi AP with web admin enabled | [Setup guide →](docs/setup-asus.md) |

### Step 2 — Install and launch

```bash
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
npm start
```

### Step 3 — Open the browser and log in

On first startup, an initial **login password** is printed to the console:

```
══════════════════════════════════════════════════════════════
  EgressView login password (initial):
  KFpDqntYRfcr...
  → Log in with this password on first access
══════════════════════════════════════════════════════════════
```

Open `http://localhost:3000` and enter the password. Each browser/device gets its own login session (30-day sliding expiry); you can review and revoke them — and change the password — in Settings → General.

### Step 4 — Configure your router

Open the Settings panel (⚙) and enter your router details:

| Field | Where to find it |
|-------|-----------------|
| Yamaha RTX IP | Your router's LAN IP (e.g. `192.168.1.1`) |
| SSH username / password | The login you set up in [Yamaha setup guide](docs/setup-yamaha.md) |
| ASUS AP IP / password | The AP's LAN IP and admin password ([ASUS setup guide](docs/setup-asus.md)) |

For the Yamaha RTX, click **Connect & Auto-detect** after entering the IP, username, and password. EgressView checks SSH access, detects the NAT descriptor (usually `100`), finds the LAN IP when available, verifies that NAT sessions can be read, and fills the recommended setting before you save.

Within a few seconds, devices, sessions, and statistics will start appearing in the UI.

> **Note:** Credentials are generated once on first startup and saved (hashed) in `.egressview.json`. If you lose the password, remove the `auth` section from `.egressview.json` and restart — a new initial password will be printed.

## Authentication

All API endpoints and the WebSocket connection are protected. Two credentials exist:

| Credential | Purpose | Where |
|-----------|---------|-------|
| **Login password** | Browser login. Each device gets its own revocable session (30-day sliding expiry) | Printed on first startup; change it in Settings → General |
| **API token** | Scripts / automation (`X-Admin-Token` header) | `.egressview.json` (`adminToken`); regenerate in Settings → General |

### Session management

- Settings → General lists every logged-in device with last-activity time
- Revoke a single device, or log out all other devices at once
- Changing the password can optionally revoke all other sessions

### If you lose the password

```bash
# Remove the auth section and restart — a new initial password is printed
node -e "const f='.egressview.json',c=require('./'+f);delete c.auth;require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
npm start
```

### How it works

- Passwords are hashed with scrypt; sessions are stored as SHA-256 hashes in SQLite
- Failed logins are delayed 500 ms; comparisons use `crypto.timingSafeEqual`
- Session tokens ride the same `X-Admin-Token` header / Socket.IO handshake as the API token

## HTTPS (optional)

By default EgressView serves plain HTTP. To enable HTTPS, add to `.egressview.json` and restart:

```json
"https": { "enabled": true }
```

A self-signed certificate (`.egressview-cert.pem` / `.egressview-key.pem`, 10-year validity) is generated automatically via the `openssl` CLI — your browser will show a one-time warning to accept it. To use your own certificate instead:

```json
"https": { "enabled": true, "certPath": "/path/to/cert.pem", "keyPath": "/path/to/key.pem" }
```

HTTPS is recommended if you use the login password from multiple devices, and required for safe remote access over the internet. Use a strong unique login password and keep EgressView updated.

## Configuration

All settings are stored in `.egressview.json` (auto-generated, gitignored). You can also use environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `POLL_INTERVAL_MS` | `60000` | ASUS polling interval (ms) |
| `ROUTER_IP` | `192.168.1.1` | Default ASUS router IP |
| `YAMAHA_IP` | — | Yamaha RTX IP address |
| `YAMAHA_USER` | — | Yamaha SSH username |
| `YAMAHA_PASS` | — | Yamaha SSH password |
| `YAMAHA_NAT` | `100` | NAT descriptor number |
| `SUBPATH` | — | Reverse proxy sub-path (e.g. `/egressview`) |
| `EGRESSVIEW_DB` | `.egressview.db` | Path to the SQLite database file |
| `LOG_LEVEL` | `info` | Log verbosity: `error` / `warn` / `info` / `debug` |

## Features

### L3/L4: Yamaha RTX (NAT Session Monitoring)

- Parses `show nat descriptor address <N> detail` output
- Tracks TCP/UDP/ICMP/GRE sessions with source, destination, port, TTL
- Auto-reconnects on SSH timeout or connection loss
- TOFU (Trust On First Use) host key verification

### L2: ASUS WiFi Access Point (Mesh-capable, Client Monitoring)

The ASUS device is used as a **WiFi access point (AP mode or AiMesh)**, not as a router. Yamaha RTX handles all L3 routing and NAT. The ASUS AP provides L2 client visibility:

- SHA256 challenge-response authentication
- Client list with connection type (wired/2.4G/5G/6G), RSSI, traffic rates
- AiMesh node discovery (multi-AP topology)
- Auto token refresh

### Device Identification

- **OUI database** (Wireshark manuf, auto-downloaded weekly)
- **mDNS/Bonjour** service discovery (100+ service types)
- **SSDP/UPnP** device detection
- **NetBIOS** name resolution
- **Apple model dictionary** (200+ models: iPhone, iPad, Mac, Apple TV, HomePod, Apple Watch)
- **Auto-investigation** mode: scans unknown devices in the background

### Investigation Views

- **Graph Map**: Whole-network topology overview for spotting unusual device/destination clusters
- **Statistics**: Time-series charts and destination summaries for traffic trends
- **Connection Log**: Full session table with threat indicators, sortable columns, and per-column search filters (text match, regex, date range)
- **Devices**: Inventory view for drilling into device identity, notes, status, and history
- **Connection panel**: Per-device list of active internet connections with org/country info
- **IPv4/IPv6 badges**: Protocol detection per device via NDP cache polling

### Threat Intelligence (C2/Botnet Detection)

- **Feodo Tracker**: Emotet/Dridex/TrickBot C2 server IPs
- **ThreatFox**: Malware IOC (IP:port)
- **URLhaus**: Malware distribution URLs (with low-confidence handling for CDN domains like GitHub)
- **Spamhaus DROP**: Hijacked IP ranges (CIDR)
- Three confidence levels: 🚨 Detected (high) / ⚠️ Review (low — legitimate service) / ✅ Clear
- Detailed threat popup with actionable guidance per confidence level
- Auto-refresh feeds every hour (configurable)

### Slack Notifications

- Sends a **Slack DM** when a threat is detected
- Configurable per-destination cooldown (default 1 hour) to prevent notification spam
- Message language follows the UI language setting (English / Japanese)
- Test-send button in settings to verify configuration
- Requires a Slack Bot Token and your User ID (`U01XXXXXXX`) — set up via Settings → Threat Detection

### Security

- Admin token authentication (timing-safe comparison)
- SSRF protection (private IP ranges only)
- Socket.IO same-origin enforcement
- SSH host key fingerprint verification (TOFU)
- Config files stored with `0600` permissions
- No passwords sent to browser (only boolean flags)

## Supported Routers

### Yamaha RTX (L3/L4)
Any model with SSH access and NAT descriptor support:
- RTX1200, RTX1210, RTX1220, RTX1300
- RTX810, RTX830
- NVR500, NVR510, NVR700W

### ASUS WiFi AP (L2, Mesh-capable)
Any model with the standard web admin interface, used in AP mode or AiMesh:
- RT-AX series (AX86U, AX88U, AX92U, etc.)
- RT-AC series
- ZenWiFi (AiMesh)

## License

EgressView is dual-licensed:

- Open source license: [GNU Affero General Public License v3.0](LICENSE)
- Commercial license: available separately for proprietary or closed-source use

You may use, modify, and distribute EgressView under the AGPL-3.0. If you include EgressView or derivative works in a proprietary product, distribute it without source code, or provide a modified version as a network service, you must comply with the AGPL-3.0 source code obligations.

If you want to use EgressView in a proprietary or closed-source commercial product without releasing the corresponding source code under the AGPL-3.0, you must obtain a commercial license from the copyright holder.

```
EgressView — Real-time network connection visualizer
Copyright (C) 2025 Yoichi Takizawa

Source code: https://github.com/yo1t/egressview
```

## Contributing

Issues and pull requests are welcome. Please open an issue first for major changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines, [ROADMAP.md](ROADMAP.md) for what's planned, and [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.
