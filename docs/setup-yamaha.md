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

## Auto-detect diagnostic display

When you press **Connect & Auto-detect**, one of the following will appear:

| Display | Meaning |
|---------|---------|
| `✓ SSH connection OK` / `✓ NAT descriptor detected` | Success — click **Save suggested settings** to finish |
| `✓ SSH connection OK` / `✗ NAT descriptor not found` | SSH succeeded but NAT could not be detected (see below) |
| `✗ SSH connection failed` / detail message | SSH itself failed (see below) |

---

## Troubleshooting

### ✗ SSH connection failed — Connection refused

The SSH service is not enabled, or EgressView is on a different LAN segment.

```
ip ssh service on
save
```

Verify on the router:
```
show ip ssh
```
`SSH service : enable` should appear. Also confirm EgressView is on the same LAN as the router.

---

### ✗ SSH connection failed — Connection timed out

The IP address may be wrong, or the router is not responding.

1. Double-check the router's IP address (e.g. `show ip route`)
2. Test from your PC/Mac:
   ```bash
   ping 192.168.1.1
   ssh egressview@192.168.1.1
   ```

---

### ✗ SSH connection failed — Authentication failed

The username or password does not match.

Verify and reset on the router console:
```
show login user
login user egressview newpassword  <!-- pragma: allowlist secret -->
save
```

---

### ✗ SSH connection failed — Host key mismatch

**Cause:** The SSH host fingerprint (hostFp) recorded during a previous connection no longer matches the router's current key.

**Common causes:**
- The router was factory-reset or firmware-updated, regenerating its SSH host key
- The router was replaced with a different unit

**Fix:**

Open `.egressview.json` (in the same directory as the server) and remove the `yamaha.hostFp` field:

```json
// Before
"yamaha": {
  "ip": "192.168.1.1",
  "user": "egressview",
  "hostFp": "abc123def456..."
}

// After (remove the hostFp line)
"yamaha": {
  "ip": "192.168.1.1",
  "user": "egressview"
}
```

Restart EgressView, then run **Connect & Auto-detect** again. The new host key will be recorded automatically (TOFU — Trust On First Use).

> ⚠️ **Security note:** If you did not reset or replace the router and this error appears, investigate your network before removing hostFp — this error can indicate a man-in-the-middle attack.

---

### ✓ SSH succeeded — NAT descriptor not found

SSH connected successfully, but EgressView could not read the NAT session table.

**Steps:**

1. Confirm NAT is configured on the router:
   ```
   show nat descriptor
   ```
   You should see `masquerade` listed.

2. Enter the NAT descriptor number manually and retry:
   Type the number from `show nat descriptor` (e.g. `100`) into the **NAT Descriptor Number** field in Settings, then run detection again.

3. Verify sessions exist on the router:
   ```
   show nat descriptor address 100 detail
   ```
   If the session count is 0, wait for a LAN device to generate traffic, then retry.

---

### No sessions appearing in EgressView (after connecting)

If the connection succeeded but the traffic log is empty:
- Re-confirm the NAT descriptor number matches `show nat descriptor`
- Check sessions on the router: `show nat descriptor address 100 detail`
- Wait for the polling interval to elapse (default: 30 seconds)

---

## Security notes

- SSH access is limited to devices on the LAN by default — no internet exposure
- EgressView only reads session data; it does **not** modify any router configuration
- You can restrict the SSH user to read-only commands using `login user privilege` if your firmware supports it
