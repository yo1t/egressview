# Widemap Roadmap

> 🇯🇵 [日本語版はこちら](ROADMAP.ja.md)

For what Widemap does today, see the [README](README.md). This page lists only what is firmly planned — and what is explicitly not.

## 🚧 Planned

### conntrack router support (OpenWrt / ASUS router mode / Ubiquiti UDM)

A shared parser for Linux `nf_conntrack` opens Widemap up to most Linux-based routers:

| Router | Firmware change needed? |
|--------|------------------------|
| ASUS (router mode) | No — stock firmware exposes `/proc/net/nf_conntrack` |
| Ubiquiti UDM / UDM-Pro / UDM-SE | No — SSH with key auth |
| OpenWrt (Buffalo, TP-Link, etc.) | Yes (flash) |

**🙋 Hardware testers wanted** — implementation can largely be done without hardware, but real-device validation cannot. If you run one of these routers, please [open an issue](https://github.com/yo1t/widemap/issues).

### Connection blocking (after conntrack support)

Write block rules to the router (Yamaha `ip filter` over SSH). Manual-approval mode only at first; auto-blocking is not planned until the false-positive rate is proven low in real use.

## ❌ Not planned

- **IPv6 session tracking via RA Proxy** — verified to break IPv6 connectivity behind some ISP ONUs. IPv6 visibility, if it comes, will use port mirroring with an optional capture node instead.
- **Cloud/SaaS data collection** — Widemap is local-first: your traffic metadata never leaves your network. This will not change.
- **Inline traffic interception** — Widemap stays passive; it will never sit in your data path or add latency.

---

Everything else — including ideas under discussion — lives in [issues](https://github.com/yo1t/widemap/issues). Feature requests welcome.
