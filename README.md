# Widemap

**Real-time network connection visualizer for Yamaha RTX routers + ASUS WiFi APs**

Widemap shows you *where* every device on your home or office network is connecting to — in real time, on a world map.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

> 🇯🇵 [日本語版 README はこちら](README.ja.md)

---

## What it does

- Connects to a **Yamaha RTX** router via SSH and reads the NAT session table every 5 seconds
- Enriches each destination IP with **reverse DNS**, **RDAP** (organization name), and **GeoIP** (latitude/longitude/city)
- Plots all connections on an interactive **world map** with animated arcs
- Identifies local devices using **OUI vendor lookup**, **mDNS/Bonjour**, **SSDP**, **NetBIOS**, and an **Apple model dictionary** (resolves down to "iPhone 15 Pro")
- Optionally connects to an **ASUS router** to get WiFi client details (band, signal strength, traffic rates)
- Keeps a **7-day connection history** with persistent storage
- Single-page dark-themed UI with graph view, map view, and statistics

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
│  ASUS Router    │◄────────►│              │
│  (Client list)  │          └──────────────┘
└─────────────────┘               │
                          ┌───────┴───────┐
                          │ Enrichment    │
                          │ • Reverse DNS │
                          │ • RDAP (org)  │
                          │ • GeoIP       │
                          │ • OUI vendor  │
                          │ • mDNS/SSDP   │
                          └───────────────┘
```

## Requirements

- **Node.js** 18+
- **Yamaha RTX** router with SSH access enabled (RTX1200, RTX1210, RTX1220, RTX1300, etc.)
- (Optional) **ASUS router** with web admin enabled

## Quick Start

```bash
git clone https://github.com/yo1t/widemap.git
cd widemap
npm install
npm start
```

On first startup, an **admin token** is printed to the console:

```
══════════════════════════════════════════════════════════════
  Widemap admin token (initial):
  a1b2c3d4e5f6...
  → Enter this token in the browser on first access
══════════════════════════════════════════════════════════════
```

Open `http://localhost:3000` and enter the token. Then configure your router connections via the Settings panel (⚙).

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

### L2: ASUS Router (WiFi Client Monitoring)

- SHA256 challenge-response authentication
- Client list with connection type (wired/2.4G/5G/6G), RSSI, traffic rates
- AiMesh node discovery
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
- **Connection panel**: Per-device list of active internet connections with org/country info

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

### ASUS (L2)
Any model with the standard web admin interface:
- RT-AX series (AX86U, AX88U, AX92U, etc.)
- RT-AC series
- ZenWiFi (AiMesh)

## Roadmap

- [ ] Threat intelligence integration (C2/botnet detection)
- [ ] SQLite-based long-term storage (2+ years)
- [ ] OpenWrt / MikroTik / pfSense support
- [ ] Alert notifications (Slack/email webhook)
- [ ] CSV/JSON export

## License

[AGPL-3.0](LICENSE) — If you modify and deploy this as a network service, you must share your changes.

## Contributing

Issues and pull requests are welcome. Please open an issue first for major changes.
