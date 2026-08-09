# EgressView Roadmap

> 🇯🇵 [日本語版はこちら](ROADMAP.ja.md)

For what EgressView does today, see the [README](README.md).

## 🚧 Planned

### macOS client

A desktop client is in development to visualize a Mac's own outbound connections by process, instead of relying on a router NAT table. It complements rather than replaces the server: the server provides broad network-wide visibility, while the client provides deeper visibility into one endpoint.

- **Lightweight monitoring:** periodically reads the macOS socket table. It requires no System Extension approval, but may miss short-lived connections and cannot provide complete byte counts.
- **Full monitoring:** uses a pass-only Network Extension to observe new flows. It provides higher-fidelity TCP, UDP/QUIC, IPv4/IPv6, and process metadata, with explicit macOS approval on first use.
- **Privacy:** it will not capture, decrypt, or store payloads. Sending observations to a Hub is separate from local collection, disabled by default, and explicitly opt-in.
- **Distribution:** the plan is a Developer ID-signed and notarized app distributed as a DMG and Homebrew Cask. Installation alone will not enable monitoring; the user chooses the monitoring mode.

The shared observation model, lightweight collector, deduplication, monitoring-mode state machine, macOS host app, pass-only System Extension foundation, and flow metadata mapping are implemented and covered by CI. The next stages are signed-build validation on real hardware, local storage, the observation UI, and explicit opt-in Hub integration. No release date is committed yet.

### conntrack router support (OpenWrt / ASUS router mode / Ubiquiti UDM)

A shared parser for Linux `nf_conntrack` opens EgressView up to many Linux-based routers, including OpenWrt, ASUS router mode, and Ubiquiti UDM-class devices.

**🙋 Hardware testers wanted** — implementation can largely be done without hardware, but real-device validation cannot. If you run one of these routers, please [open an issue](https://github.com/yo1t/egressview/issues).

### Connection blocking

Write block rules to the router (Yamaha `ip filter` over SSH). Manual-approval mode only at first; auto-blocking is not planned until the false-positive rate is proven low in real use.

---

Everything else — including ideas under discussion — lives in [issues](https://github.com/yo1t/egressview/issues). Feature requests welcome.
