# EgressView Roadmap

> 🇯🇵 [日本語版はこちら](ROADMAP.ja.md)

For what EgressView does today, see the [README](README.md).

## ✅ Available now

### macOS agent

A signed and notarized macOS agent ships with v1.9.0. It visualizes a Mac's own outbound connections by process instead of relying on a router NAT table, complementing the server rather than replacing it. It offers lightweight monitoring (socket table, no System Extension approval) and full monitoring (a pass-only Network Extension for higher-fidelity flows), never captures payloads, and reports to a Hub only as an explicit, off-by-default opt-in.

## 🚧 Planned

### Full-featured macOS agent

A richer version of the macOS agent is in development — turning it from a collector into a standalone app with its own dashboards and visualizations, on-device threat matching so a Mac is protected even when away from its home network, notifications, and AI insights. Agent-side changes are batched into a single release because each one requires signing, notarization, and reinstall. No release date is committed yet.

### conntrack router support (OpenWrt / ASUS router mode / Ubiquiti UDM)

A shared parser for Linux `nf_conntrack` opens EgressView up to many Linux-based routers, including OpenWrt, ASUS router mode, and Ubiquiti UDM-class devices.

**🙋 Hardware testers wanted** — implementation can largely be done without hardware, but real-device validation cannot. If you run one of these routers, please [open an issue](https://github.com/yo1t/egressview/issues).

### Connection blocking

Write block rules to the router (Yamaha `ip filter` over SSH). Manual-approval mode only at first; auto-blocking is not planned until the false-positive rate is proven low in real use.

---

Everything else — including ideas under discussion — lives in [issues](https://github.com/yo1t/egressview/issues). Feature requests welcome.
