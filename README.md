# EgressView

**Home / SOHO Network Security Monitor — Real-time visibility into every LAN device's outbound connections**

Is your smart TV phoning home to unexpected servers? Are your IP cameras, IoT appliances, or NAS boxes making connections you never authorised? EgressView answers these questions by passively monitoring every outbound connection from every device on your LAN, then turning that data into an investigation workflow.

No new hardware. No inline traffic interception. It reads the NAT session tables your existing Yamaha RTX or Cisco IOS router already keeps, so nothing sits in the path of your traffic and nothing slows down.

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22-green)
![Release](https://img.shields.io/badge/release-v2.0.2-3fb950)

> 🇯🇵 [日本語版 README はこちら](README.ja.md) | 🌐 [Project Page](https://yo1t.github.io/egressview/) | 📋 [Changelog](CHANGELOG.md) · [Releases](https://github.com/yo1t/egressview/releases)

---

## See it in action

### ▶ Watch it work

Graph Map and Statistics for the whole network, then Connection Log and Devices to drill into one suspicious destination — the same path you would take during a real investigation. UI language is English or Japanese.

https://github.com/user-attachments/assets/9448d75b-a7fe-4363-8d35-da17abaed0ee

![Detection Log detail popup](docs/assets/egressview-detection-log.png)
*A device reached a known command-and-control address. This is the moment the tool exists for — the record is kept whether or not you have Slack configured.*

![Graph Map overview](docs/assets/egressview-graph-map.png)
*Every device and everywhere it went, at once. Clusters that do not belong to anything you set up are where you start looking.*

![Connection Log drill-down](docs/assets/egressview-connection-log.png)
*From a suspicion to the individual sessions: filter by time, sort, search per column, then pivot to the device that made them.*

### Try it without a router

You can run the whole interface against sample data before touching any hardware — the fastest way to decide whether this is worth your evening:

```bash
git clone https://github.com/yo1t/egressview.git
cd egressview && npm install
DEMO_MODE=true DEMO_ADMIN_TOKEN=my-token npm start
```

Open `http://localhost:3000` and enter `my-token`. It seeds 160 realistic connections, every view works, and a **DEMO** badge sits in the header so you can never confuse it with a live install.

---

## What it does

**Tells you which of your devices is talking, and to whom.** Every connection is tagged to its source device by vendor, model, and hostname — resolved through OUI lookup, mDNS/Bonjour, SSDP, NetBIOS, and a 200-model Apple dictionary — so a suspicious destination comes with the name of the thing that reached for it rather than an IP you have to look up.

**Warns you when a device reaches something known to be dangerous.** Every connection is checked in real time against Feodo Tracker, ThreatFox, URLhaus, and Spamhaus DROP, refreshed hourly. Findings are graded 🚨 Detected / ⚠️ Review / ✅ Clear, because a CDN that also hosts malware is not the same as a botnet controller, and treating them alike trains you to ignore alerts.

**Reaches you when you are not looking at the screen.** A Slack DM goes out the moment a device connects to a known C2 or malware host, with a per-destination cooldown so one noisy endpoint cannot flood you. Threat detections and new-device alerts have independent switches for Slack and for in-app history, so you can quieten one without losing the record of the other.

**Keeps the evidence.** Connections are stored in SQLite (WAL, crash-safe, retention configurable up to two years), and the Detection Log keeps every threat and new-device alert with per-column filters and click-through detail — so "when did this start?" is a question you can actually answer.

**Names the destination, not just the address.** Each destination is enriched with reverse DNS, RDAP organisation, and GeoIP; the dnsmasq query log, when available, supplies the real hostname a device asked for. The App column infers the service behind a session — APNs, iCloud, QUIC, MQTT/TLS, AirPlay, YouTube, AWS, Slack, Zoom and more — so ordinary traffic identifies itself and the unusual stands out.

**Catches what a 60-second poll would miss.** The Yamaha `[INSPECT]` syslog is tailed live for short TCP sessions that open and close between polls, and `[DHCPD]` events keep IP-to-MAC mapping current as leases move.

**Watches more than one router.** Up to ten Yamaha and Cisco routers in any mix, polled independently so one unreachable router does not stop the others. A connection seen by several routers is stored once, keeping every observer.

**Sees inside your Mac, where a router cannot.** A router shows what left the house but not which application sent it. The [EgressView Agent for macOS](apps/agent-macos/README.md) reports the process behind each outbound connection — metadata only, never payloads.

**Answers questions in plain language.** The built-in MCP server exposes 11 tools to AI assistants such as AWS Kiro, Anthropic Claude, and Anysphere Cursor, so "what did 192.168.1.50 connect to this week?" is something you can simply ask. In-app **AI Insights** opens with collection health, traffic, threats, and period comparisons.

**Works from a phone.** Router health, Graph Map, Statistics, Connection Log, Devices, and Detection Log are usable on a phone over your VPN or private network.

**Optional: names your Wi-Fi clients.** An ASUS access point in AP or AiMesh mode adds band, signal strength, traffic rates, and mesh topology for wireless devices.

**Optional: investigate a specific address on demand.** AbuseIPDB, VirusTotal, or AlienVault OTX are queried only when you explicitly ask, with server-side caching and rate limits ([guide](docs/manual-threat-investigation.md)).

---

## Does it work with my setup?

**You need a Yamaha RTX or a Cisco IOS router.** There is no packet capture mode and no inline option.

**The macOS agent alone covers one Mac, not your network.** It runs without a router, and everything applies to what it reports — threat matching, destination enrichment, the Detection Log, Slack. Flows are captured as they happen, so nothing is lost to a polling gap, and each one carries the application that made it.

What you do not get is the rest of the house: no other device on the LAN is visible, and neither is anything the Mac is not doing. **The agent tells you everything about one machine; the router is what tells you about the twenty you cannot install software on.**

| | Requirement |
|--|-------------|
| ✅ | **Node.js 22+** on any Mac, PC, or Raspberry Pi that stays on |
| ✅ | **At least one Yamaha RTX or Cisco IOS router** with SSH enabled ([Yamaha](docs/setup-yamaha.md) · [Cisco](docs/setup-cisco.md)) |
| ☐ | Optional: an **ASUS access point** in AP/AiMesh mode, for Wi-Fi client detail ([setup](docs/setup-asus.md)) |

**Yamaha RTX** — any model with SSH and NAT descriptor support: RTX1200, RTX1210, RTX1220, RTX1300, RTX810, RTX830, NVR500, NVR510, NVR700W.

**Cisco IOS** — physically validated on a C841M-4X-JSEC/K9 running IOS 15.5(3)M9, covering SSH, enable, NAT/ARP/NDP, verbose output, TOFU, and automatic reconnect.

**Linux routers** — collection over SSH using conntrack is a preview: verified against Docker, **not yet validated on hardware** ([setup](docs/setup-conntrack.md)).

**What multi-router support has and has not been proven to do.** The automated gate runs 10 mixed fake routers at 1,000 sessions each with failure isolation and deterministic deduplication, and one physical Cisco and one physical Yamaha were each registered twice under different router IDs. That establishes parallel collection and deduplication. It does **not** establish HSRP/VRRP, NAT state synchronisation, or real failover, and multiple distinct units of the same vendor have not been tested physically. Please report device-specific output differences through GitHub Issues.

---

## Quick Start

**About 15 minutes, and most of it is the router.** Getting the software running took 7 seconds when measured on a Mac (clone 0.9 s, `npm install` 4.0 s, first launch to ready 2 s); enabling SSH on a router you have never logged into is what takes the rest.

Start with the smallest path that matches your network. You can add sources later from Settings without redoing anything.

| Pattern | Use this when |
|---------|---------------|
| One Yamaha RTX or Cisco IOS | You want the fastest first run |
| Up to 10 routers | You have redundant routers or multiple uplinks |
| + ASUS AP | You also want Wi-Fi client names, vendors, and MAC visibility |
| + dnsmasq / INSPECT / DHCPD | You want real hostnames, short-lived sessions, and live IP-to-MAC mapping |
| + Slack | You want detections delivered by DM |

### 1. Install and launch

```bash
git clone https://github.com/yo1t/egressview.git
cd egressview
npm install
npm start
```

### 2. Log in

A login password is printed once, on an interactive terminal. A service or non-interactive start writes it instead to `.egressview.json.initial-login-password` with mode `0600`, rather than leaving it in a log that persists:

```
══════════════════════════════════════════════════════════════
  EgressView login password (initial):
  KFpDqntYRfcr...
  → Log in with this password on first access
══════════════════════════════════════════════════════════════
```

Open `http://localhost:3000` and enter it. Each browser gets its own session with a 30-day sliding expiry, and you can review or revoke them in Settings → General. Delete the one-time password file after you are in.

### 3. Add your router

Settings → **L3/L4**, one row per router. Enter the LAN IP and the SSH login from the [Yamaha](docs/setup-yamaha.md) or [Cisco](docs/setup-cisco.md) guide, then click **Connect & Auto-detect**.

Auto-detect checks SSH access, finds the NAT descriptor (usually `100`), locates the LAN address, and confirms that NAT sessions can actually be read — **before you save**, so a wrong password fails while you are still looking at the screen rather than silently collecting nothing.

### 4. Watch it fill in

Devices, sessions, and statistics start appearing within a few seconds. Nothing else is required; everything below is optional.

---

## Going further

Each of these is optional and has its own guide.

| | |
|---|---|
| [macOS Agent](apps/agent-macos/README.md) | See which application on a Mac made a connection, where it went on a map, and whether the destination is on a threat feed (needs Hub 1.9.0+; threat feeds need Hub 1.10.0+) |
| [AI assistant access (MCP)](docs/setup-mcp.md) | Ask about your network in plain language from Claude, Kiro, or Cursor — 11 tools, stdio or HTTP |
| [AI Insights](docs/setup-ai-insights.md) · [Bedrock](docs/setup-bedrock.md) | Summaries and analysis through Ollama, Anthropic, OpenAI, or Amazon Bedrock, with monthly token and cost tracking |
| [Authentication & HTTPS](docs/authentication.md) | Sessions, Google OIDC, roles, audit log, and turning on TLS. **Read this before exposing EgressView to the internet** |
| [Configuration](docs/configuration.md) | Port, database path, memory limits — the settings that must exist before startup |
| [Architecture](docs/architecture.md) · [REST API](docs/api-reference.md) | Component boundaries, data flow, and automation |
| [Deployment profiles](docs/deployment-profiles.md) | Local, private, public, or fully air-gapped — including offline mode |
| [Signed distribution](docs/offline-distribution.md) | Install a signed portable release and verify it with nothing but `openssl` |
| [Additional data sources](docs/setup-conntrack.md) | dnsmasq, `[INSPECT]`, `[DHCPD]`, and Linux conntrack |

---

## License

EgressView is dual-licensed.

- Open source: [GNU Affero General Public License v3.0](LICENSE)
- Commercial: available separately for proprietary or closed-source use

You may use, modify, and distribute EgressView under the AGPL-3.0. If you include EgressView or derivative works in a proprietary product, distribute it without source code, or provide a modified version as a network service, you must comply with the AGPL-3.0 source code obligations. To use it in a proprietary product without releasing the corresponding source, you need a commercial license from the copyright holder.

```
EgressView — Real-time network connection visualizer
Copyright (C) 2025 Yoichi Takizawa

Source code: https://github.com/yo1t/egressview
```

## Trademarks

AWS Kiro, Anthropic Claude, Anysphere Cursor, Cisco, Cisco IOS, Yamaha, ASUS, and other product names are trademarks or registered trademarks of their respective owners. EgressView is not affiliated with, endorsed by, or sponsored by those companies.

## Contributing

Issues and pull requests are welcome. Please open an issue first for major changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, [ROADMAP.md](ROADMAP.md) for what is planned, and [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.
