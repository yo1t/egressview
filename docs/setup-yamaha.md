# Yamaha RTX — SSH Setup Guide

This guide explains how to enable SSH access on your Yamaha RTX router so Widemap can connect to it.

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
# Create a dedicated user for Widemap (replace "widemap" and "yourpassword")
login user widemap yourpassword
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

## Step 4 — Check the NAT descriptor number

Widemap reads the NAT session table. Find the descriptor number used by your router:

```
show nat descriptor
```

Example output:
```
NAT descriptor list:
  100: masquerade
```

Note this number (typically `100`). You will enter it in Widemap's Settings panel.

---

## Step 5 — Save the configuration

```
save
```

---

## Step 6 — Test SSH connectivity from your PC/Mac

```bash
ssh widemap@192.168.1.1
```

If you can log in successfully, the setup is complete.

---

## Step 7 — Enter settings in Widemap

Open the Widemap Settings panel (⚙) and fill in:

| Field | Value |
|-------|-------|
| Yamaha RTX IP | Your router's LAN IP (e.g. `192.168.1.1`) |
| SSH username | `widemap` (or whatever you chose) |
| SSH password | The password you set |
| NAT descriptor | The number from `show nat descriptor` (e.g. `100`) |

---

## Troubleshooting

**SSH connection refused**
- Confirm `ip ssh service on` was run and saved
- Check that your PC/Mac is on the same LAN as the router

**Authentication failed**
- Verify the username and password with `show login user`
- Re-enter the password: `login user widemap newpassword` then `save`

**No sessions appearing in Widemap**
- Confirm the NAT descriptor number matches what `show nat descriptor` returns
- Run `show nat descriptor address 100 detail` on the router to verify sessions exist

---

## Security notes

- SSH access is limited to devices on the LAN by default — no internet exposure
- Widemap only reads session data; it does **not** modify any router configuration
- You can restrict the SSH user to read-only commands using `login user privilege` if your firmware supports it
