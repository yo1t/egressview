# EgressView Roadmap

> 🇯🇵 [日本語版はこちら](ROADMAP.ja.md)

For what EgressView does today, see the [README](README.md).

## 🚧 Planned

### conntrack router support (OpenWrt / ASUS router mode / Ubiquiti UDM)

A shared parser for Linux `nf_conntrack` opens EgressView up to many Linux-based routers, including OpenWrt, ASUS router mode, and Ubiquiti UDM-class devices.

**🙋 Hardware testers wanted** — implementation can largely be done without hardware, but real-device validation cannot. If you run one of these routers, please [open an issue](https://github.com/yo1t/egressview/issues).

### Connection blocking

Write block rules to the router (Yamaha `ip filter` over SSH). Manual-approval mode only at first; auto-blocking is not planned until the false-positive rate is proven low in real use.

---

Everything else — including ideas under discussion — lives in [issues](https://github.com/yo1t/egressview/issues). Feature requests welcome.
