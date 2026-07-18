# Linux conntrack router setup (preview)

EgressView can collect IPv4 NAT sessions over SSH from Linux-based routers that expose either `/proc/net/nf_conntrack` or `conntrack -L`.

> This adapter has passed automated SSH integration testing against a privileged Linux router container. OpenWrt, ASUSWRT/Merlin, and Ubiquiti hardware confirmation is still pending, so treat it as a preview.

## Requirements

- A private IPv4 management address reachable from EgressView
- SSH password authentication on port 22
- An account allowed to read conntrack state, normally `root` or `CAP_NET_ADMIN`
- `ip -4 neigh`, `ip -6 neigh`, and `ip -o -4 addr` for device and LAN address detection

EgressView first runs `cat /proc/net/nf_conntrack`. If that path is unavailable or permission is denied, it falls back to `conntrack -L`. If neither command is usable, collection fails with an actionable error instead of reporting an empty session table.

## Add the router

1. Open **Settings > Router** and select **Linux conntrack**.
2. Enter the management IP, SSH username, and password.
3. Select **Connect & Auto-detect** and confirm that SSH, LAN IP, and session count are shown.
4. Save the router and confirm that its status becomes green.

The first successful connection pins the SSH host key. A changed host key is rejected until the management IP is deliberately changed or the router entry is recreated.

Do not expose router SSH to the Internet. Use a management network or VPN, and grant only the permissions needed to read conntrack and neighbor state where possible. EgressView stores the SSH password in the mode-`0600`, Git-ignored `.egressview.json` file.
