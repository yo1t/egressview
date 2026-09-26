# EgressView Roadmap

> 🇯🇵 [日本語版はこちら](ROADMAP.ja.md)

For what EgressView does today, see the [README](README.md).

## ✅ Available now

### Agent for Mac

The signed and notarized Mac app visualizes this Mac's outbound connections by process. Network monitoring uses a pass-only Network Extension and requires macOS approval. The app includes a globe, connection history, local threat matching, notifications, and optional AI insights. It does not collect packet contents. Hub delivery is off by default and requires an explicit opt-in.

### Agent for Windows

The Windows app records this PC's outbound connections and originating processes through a local service. It provides local history and visualizations without a Hub; Hub delivery is optional. The currently distributed MSI is not Authenticode-signed, so verify its checksum before installation. See the [Windows installation guide](apps/agent-windows/README.en.md).

### Linux conntrack collection (preview)

The shared Linux `nf_conntrack` adapter is implemented and has automated integration tests. OpenWrt, ASUS router mode, and Ubiquiti hardware have not yet been verified; see the [preview setup guide](docs/setup-conntrack.md).

## 🚧 Planned

### Linux router hardware validation

The conntrack adapter remains a preview until it is checked on representative physical routers. Hardware-specific setup requirements and failure modes may differ from the container-based tests.

**🙋 Hardware testers wanted** — implementation can largely be done without hardware, but real-device validation cannot. If you run one of these routers, please [open an issue](https://github.com/yo1t/egressview/issues).

### Connection blocking

Write block rules to the router (Yamaha `ip filter` over SSH). Manual-approval mode only at first; auto-blocking is not planned until the false-positive rate is proven low in real use.

---

Everything else — including ideas under discussion — lives in [issues](https://github.com/yo1t/egressview/issues). Feature requests welcome.
