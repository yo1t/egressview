# Yamaha RTX — SSH Setup Guide

This guide explains how to enable SSH access on your Yamaha RTX router so EgressView can connect to it.

**Supported models:** RTX1200, RTX1210, RTX1220, RTX1300, RTX810, RTX830, NVR500, NVR510, NVR700W

---

## Step 1 — Log in to the router

Connect to the router console via the web interface or a direct serial/telnet connection.

**Web interface:** Open `http://<router-ip>/` in your browser and log in as administrator.

**Telnet (if enabled):**
```bash
telnet 192.168.1.1
```

---

## Step 2 — Create an SSH login user

```
# Create a dedicated user for EgressView (replace "egressview" and "yourpassword")
login user egressview yourpassword <!-- pragma: allowlist secret -->
```

> **Tip:** Use a dedicated user rather than the administrator account. This limits the scope of access if the credentials are ever compromised.

---

## Step 3 — Enable the SSH service

```
ip ssh service on
```

Verify the SSH service is running:
```
show ip ssh
```

Expected output:
```
SSH service     : enable
...
```

---

## Step 4 — Verify NAT is configured (set it up if not already)

EgressView reads the NAT session table, so NAT (masquerade) must be running on the router first.

Check the current configuration:

```
show nat descriptor
```

Expected output (NAT already configured):
```
NAT descriptor list:
  100: masquerade
```

If you see `masquerade` listed, NAT is already set up. **Skip to Step 5.**

---

### If NAT is not configured — sample configuration

> ⚠️ **All addresses below are dummy values. Replace them with your actual environment settings.**
> Configuration varies by ISP and contract. Check your ISP's documentation or support if unsure.

```
# LAN interface address (change to your actual LAN address)
ip lan1 address 192.168.1.1/24

# Default route via WAN gateway (change to the gateway IP provided by your ISP)
ip route default gateway 203.0.113.1

# NAT descriptor
nat descriptor type 100 masquerade
nat descriptor address outer 100 primary

# Basic security filters (block Windows file sharing ports, etc.)
ip filter 200010 reject * * udp,tcp * 135
ip filter 200020 reject * * udp,tcp 135 *
ip filter 200030 reject * * tcp * 139
ip filter 200040 reject * * tcp 139 *
ip filter 500000 pass * * * * *

# Apply NAT and filters to the WAN interface (change lan2 to your WAN port name)
ip lan2 nat descriptor 100
ip lan2 secure filter in 200010 200020 200030 200040
ip lan2 secure filter out 500000

# Save
save
```

> **Common things to change:**
> - `192.168.1.1/24` → your actual LAN address (e.g. `192.168.0.1/24`)
> - `203.0.113.1` → the gateway IP from your ISP (PPPoE setups may use `pp 1` instead)
> - `lan2` → your WAN port name (may be `lan2`, `pp 1`, etc. depending on your setup)

---

## Step 5 — Check the NAT descriptor number

EgressView reads the NAT session table. Find the descriptor number used by your router:

```
show nat descriptor
```

Example output:
```
NAT descriptor list:
  100: masquerade
```

Note this number (typically `100`). You will enter it in EgressView's Settings panel.

---

## Step 6 — Save the configuration

```
save
```

---

## Step 7 — Test SSH connectivity from your PC/Mac

```bash
ssh egressview@192.168.1.1
```

If you can log in successfully, the setup is complete.

---

## Step 8 — Enter settings in EgressView

Open the EgressView Settings panel (⚙) and fill in:

| Field | Value |
|-------|-------|
| Yamaha RTX IP | Your router's LAN IP (e.g. `192.168.1.1`) |
| SSH username | `egressview` (or whatever you chose) |
| SSH password | The password you set |
| NAT descriptor | The number from `show nat descriptor` (e.g. `100`) |

---

## Troubleshooting

**SSH connection refused**
- Confirm `ip ssh service on` was run and saved
- Check that your PC/Mac is on the same LAN as the router

**Authentication failed**
- Verify the username and password with `show login user`
- Re-enter the password: `login user egressview newpassword` then `save` <!-- pragma: allowlist secret -->

**No sessions appearing in EgressView**
- Confirm the NAT descriptor number matches what `show nat descriptor` returns
- Run `show nat descriptor address 100 detail` on the router to verify sessions exist

---

## Security notes

- SSH access is limited to devices on the LAN by default — no internet exposure
- EgressView only reads session data; it does **not** modify any router configuration
- You can restrict the SSH user to read-only commands using `login user privilege` if your firmware supports it
