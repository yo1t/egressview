# Widemap

**Real-time network connection visualizer for Yamaha RTX routers + ASUS WiFi Access Points**

Widemap shows you *where* every device on your home or office network is connecting to — in real time, on a world map.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

> 🇯🇵 [日本語版 README はこちら](README.ja.md) | 🌐 [Project Page](https://yo1t.github.io/widemap/)

---

## What it does

- Connects to a **Yamaha RTX** router via SSH and reads the NAT session table every 5 seconds
- Enriches each destination IP with **reverse DNS**, **RDAP** (organization name), and **GeoIP** (latitude/longitude/city)
- Plots all connections on an interactive **world map** with animated arcs
- Identifies local devices using **OUI vendor lookup**, **mDNS/Bonjour**, **SSDP**, **NetBIOS**, and an **Apple model dictionary** (resolves down to "iPhone 15 Pro")
- Optionally connects to an **ASUS WiFi access point** (used as AP/mesh, not as a router) to get WiFi client details (band, signal strength, traffic rates, AiMesh topology)
- Keeps a **7-day connection history** in **SQLite** (WAL mode, crash-safe)
- **Threat intelligence**: matches all connections against Feodo Tracker, ThreatFox, URLhaus, and Spamhaus DROP feeds (auto-refreshed hourly)
- **Connection log**: sortable/searchable table of all sessions with threat status badges
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
┌─────────────────┐   SSH    ┌──────────────┐
│  Yamaha RTX     │◄────────►│              │
│  (NAT table)    │          │   Widemap    │   WebSocket
└─────────────────┘          │   Server     │◄──────────► Browser
┌─────────────────┐  HTTP    │  (Node.js)   │
│  ASUS WiFi AP   │◄────────►│              │
│  (Client list)  │          └──────┬───────┘
└─────────────────┘                 │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
              │ Enrichment│  │  Threat   │  │  SQLite   │
              │ • Rev DNS │  │  Intel    │  │  History  │
              │ • RDAP    │  │ • Feodo   │  │  (WAL)    │
              │ • GeoIP   │  │ • TFox    │  └───────────┘
              │ • OUI     │  │ • URLhaus │
              │ • mDNS    │  │ • DROP    │
              └───────────┘  └───────────┘
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

## Roadmap

- [x] ~~Modular architecture (server.js split into src/ modules)~~
- [x] ~~SQLite-based persistent storage~~
- [x] ~~Threat intelligence (C2/botnet detection via Feodo, ThreatFox, URLhaus, Spamhaus)~~
- [x] ~~Connection log with sortable/searchable table~~
- [x] ~~IPv4/IPv6 protocol badges (NDP detection)~~
- [ ] Alert notifications (Slack/email webhook)
- [ ] OpenWrt / MikroTik / pfSense support
- [ ] DNS log monitoring (L7 visibility)
- [ ] IPv6 traffic monitoring (packet mirror method)
- [ ] AWS VPC Flow Logs integration
- [ ] Mobile app (iOS/Android via Capacitor)
- [ ] CSV/JSON export

## License

[AGPL-3.0](LICENSE) — If you modify and deploy this as a network service, you must share your changes.

```
Widemap — Real-time network connection visualizer
Copyright (C) 2025 Yoichi Takizawa

Source code: https://github.com/yo1t/widemap
```

## Contributing

Issues and pull requests are welcome. Please open an issue first for major changes.
