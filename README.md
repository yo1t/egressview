# Widemap

**Home / SOHO Network Security Monitor — Real-time visibility into every LAN device's outbound connections**

Is your smart TV phoning home to unexpected servers? Are your IP cameras, IoT appliances, or NAS boxes making connections you never authorised? Widemap answers these questions by passively monitoring every outbound connection from every device on your LAN and displaying them on an interactive world map — in real time, with automatic threat detection.

No new hardware. No inline traffic interception. Works via your existing Yamaha RTX router's NAT session table.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

> 🇯🇵 [日本語版 README はこちら](README.ja.md) | 🌐 [Project Page](https://yo1t.github.io/widemap/)

---

## For Home / SOHO Security

Modern home and SOHO networks run 20–40 devices: smart TVs, IP cameras, NAS drives, Wi-Fi speakers, printers, network switches, PCs, and smartphones. Many of these — especially IoT equipment — update infrequently and have unknown outbound behaviors. Any of them can be silently compromised and begin exfiltrating data or relaying traffic for a botnet.

Widemap answers the question most home users can't ask: *what is each device on my network actually connecting to?*

- **Passive, zero-impact monitoring** — reads the router's NAT session table over SSH; no inline tap, no throughput penalty, no latency added
- **Per-device visibility** — every connection tagged to the source device (vendor, model, hostname) via OUI, mDNS, SSDP, and NetBIOS
- **Automatic threat detection** — every connection checked in real time against Feodo Tracker, ThreatFox, URLhaus, and Spamhaus DROP
- **Instant Slack alerts** — DM the moment any device connects to a known C2 server or malware distribution host
- **No hardware changes** — runs on any Mac, PC, or Raspberry Pi alongside your existing Yamaha RTX router

## What it does

- Connects to a **Yamaha RTX** router via SSH and reads the NAT session table every 60 seconds
- **[INSPECT] syslog supplement** — tails the Yamaha syslog in real time to capture short-lived TCP sessions that complete within the 60-second polling gap
- **dnsmasq DNS query log** — tails the EC2/server-side dnsmasq log to resolve destination IPs to meaningful domain names (e.g. `data.meethue.com`) per client device; forward DNS names take priority over PTR reverse lookups
- **[DHCPD] syslog tracking** — tails Yamaha DHCP events (Allocates/Extends) for real-time IP→MAC mapping
- **Threat intelligence**: matches all connections against Feodo Tracker, ThreatFox, URLhaus, and Spamhaus DROP feeds (auto-refreshed hourly)
- **Slack notifications**: sends a DM when a threat is detected (configurable cooldown, language-aware)
- Identifies local devices using **OUI vendor lookup**, **mDNS/Bonjour**, **SSDP**, **NetBIOS**, and an **Apple model dictionary** (resolves down to "iPhone 15 Pro")
- Enriches each destination IP with **reverse DNS**, **RDAP** (organization name), and **GeoIP** (latitude/longitude/city)
- Plots all connections on an interactive **world map** with animated arcs
- Optionally connects to an **ASUS WiFi access point** (used as AP/mesh, not as a router) to get WiFi client details (band, signal strength, traffic rates, AiMesh topology)
- Keeps a **connection history** in **SQLite** (WAL mode, crash-safe; configurable retention up to 2 years)
- **Connection log**: sortable/searchable table of all sessions with threat status badges
- **📡 Data Sources tab** — configure each data source (dnsmasq / [INSPECT] / [DHCPD]) independently from the settings UI
- Single-page dark-themed UI with graph view, map view, statistics, and connection log

## Demo

https://github.com/user-attachments/assets/9360b145-60cb-46b1-8489-898d7ea62b60

> UI language: English / Japanese selectable

Visualise NAT session data as a force-directed network graph, animated arcs on a world map, and time-series trend charts — all updating in real time.

The sidebar lists every device on your LAN, enriched with hostnames, vendor names, and model info beyond just IP and MAC addresses. Select a device to filter the map and graph to show only its active connections.

## Screenshots

![widemap1](docs/widemap1.png)
![widemap2](docs/widemap2.png)
![widemap3](docs/widemap3.png)

## Architecture

```
┌─────────────────┐  SSH (NAT)  ┌──────────────────────┐
│  Yamaha RTX     │◄───────────►│                      │
│  [INSPECT] log  │  syslog/UDP │   Widemap Server     │  WebSocket
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

## Quick Start

### Step 1 — Prerequisites checklist

| | Requirement | Setup guide |
|--|-------------|-------------|
| ✅ | Node.js 18+ installed on your Mac/PC/Raspberry Pi | [nodejs.org](https://nodejs.org) |
| ✅ | Yamaha RTX router with SSH enabled | [Setup guide →](docs/setup-yamaha.md) |
| ☐ | (Optional) ASUS WiFi AP with web admin enabled | [Setup guide →](docs/setup-asus.md) |

### Step 2 — Install and launch

```bash
git clone https://github.com/yo1t/widemap.git
cd widemap
npm install
npm start
```

### Step 3 — Open the browser and enter the admin token

On first startup, an **admin token** is printed to the console:

```
══════════════════════════════════════════════════════════════
  Widemap admin token (initial):
  a1b2c3d4e5f6...
  → Enter this token in the browser on first access
══════════════════════════════════════════════════════════════
```

Open `http://localhost:3000` and enter the token.

### Step 4 — Configure your router

Open the Settings panel (⚙) and enter your router details:

| Field | Where to find it |
|-------|-----------------|
| Yamaha RTX IP | Your router's LAN IP (e.g. `192.168.1.1`) |
| SSH username / password | The login you set up in [Yamaha setup guide](docs/setup-yamaha.md) |
| NAT descriptor number | Run `show nat descriptor` on the router — typically `100` |
| ASUS AP IP / password | The AP's LAN IP and admin password ([ASUS setup guide](docs/setup-asus.md)) |

Within a few seconds, devices and connections will start appearing on the map.

> **Note:** The admin token is generated once on first startup and saved in `.widemap.json`. If you lose it, delete `.widemap.json` and restart — a new token will be generated.

## Admin Token

The admin token protects all API endpoints and the WebSocket connection. It is required every time you open the browser UI.

### Where to find it

1. **First startup** — printed to the console (stdout) as shown above
2. **After first startup** — stored in `.widemap.json` (field: `adminToken`)

### If you lose the token

```bash
# Option 1: Read from the config file
cat .widemap.json | grep adminToken

# Option 2: Reset (generates a new token)
rm .widemap.json
npm start
```

### How it works

- The browser prompts for the token on first access and stores it in `localStorage`
- Every API request includes the token in the `X-Admin-Token` header
- WebSocket connections pass the token via Socket.IO handshake auth
- Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks

## Configuration

All settings are stored in `.widemap.json` (auto-generated, gitignored). You can also use environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `POLL_INTERVAL_MS` | `2000` | ASUS polling interval (ms) |
| `ROUTER_IP` | `192.168.1.1` | Default ASUS router IP |
| `YAMAHA_IP` | — | Yamaha RTX IP address |
| `YAMAHA_USER` | — | Yamaha SSH username |
| `YAMAHA_PASS` | — | Yamaha SSH password |
| `YAMAHA_NAT` | `100` | NAT descriptor number |
| `SUBPATH` | — | Reverse proxy sub-path (e.g. `/widemap`) |

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

### Visualization

- **Graph view**: Force-directed network topology
- **World map**: Destination IPs plotted with animated arcs from your location
- **Statistics**: Time-series charts and bar charts of session counts per destination
- **Connection log**: Full session table with threat indicators, sortable columns, and per-column search filters (text match, regex, date range)
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

Widemap is dual-licensed:

- Open source license: [GNU Affero General Public License v3.0](LICENSE)
- Commercial license: available separately for proprietary or closed-source use

You may use, modify, and distribute Widemap under the AGPL-3.0. If you include Widemap or derivative works in a proprietary product, distribute it without source code, or provide a modified version as a network service, you must comply with the AGPL-3.0 source code obligations.

If you want to use Widemap in a proprietary or closed-source commercial product without releasing the corresponding source code under the AGPL-3.0, you must obtain a commercial license from the copyright holder.

```
Widemap — Real-time network connection visualizer
Copyright (C) 2025 Yoichi Takizawa

Source code: https://github.com/yo1t/widemap
```

## Contributing

Issues and pull requests are welcome. Please open an issue first for major changes.
