# ASUS WiFi AP — Setup Guide

This guide explains how to prepare your ASUS WiFi access point for Widemap.

Widemap uses the ASUS device as a **WiFi access point (AP mode or AiMesh node)** — not as a router. The Yamaha RTX handles all routing and NAT. The ASUS AP provides L2 visibility: which devices are connected, on which band (2.4G/5G/6G), and their signal strength and traffic rates.

**Supported models:** RT-AX series (AX86U, AX88U, AX92U, etc.), RT-AC series, ZenWiFi (AiMesh)

---

## Step 1 — Set the ASUS device to AP mode

> **Skip this step if your ASUS device is already in AP mode or acting as an AiMesh node.**

1. Open the ASUS web admin interface: `http://<asus-ip>/` (default IP is usually `192.168.1.2` or `192.168.50.1`)
2. Go to **Administration** → **Operation Mode**
3. Select **Access Point (AP) mode**
4. Click **Save** and wait for the device to reboot

In AP mode, the ASUS device bridges WiFi clients to the Yamaha RTX LAN. It gets its own LAN IP (assigned by the Yamaha RTX via DHCP or set statically).

---

## Step 2 — Find the ASUS AP's LAN IP address

After the reboot, find the AP's IP address in one of these ways:

**From the Yamaha RTX:**
```
show arp
```
Look for the ASUS MAC address in the ARP table.

**From the ASUS web interface (if you can still reach it):**
Check **Network Map** → the device's own IP is shown at the top.

**From your PC/Mac:**
```bash
# macOS/Linux
arp -a | grep -i asus
```

---

## Step 3 — Confirm web admin is accessible

Open `http://<asus-ap-ip>/` in your browser. You should see the ASUS login screen.

> **Note:** In AP mode, the default admin credentials are the same as before (username: `admin`, password: whatever you set).

---

## Step 4 — Enter settings in Widemap

Open the Widemap Settings panel (⚙) and fill in:

| Field | Value |
|-------|-------|
| ASUS AP IP | The AP's LAN IP (e.g. `192.168.1.2`) |
| ASUS AP password | Your admin password |

Widemap will authenticate automatically using SHA256 challenge-response and start polling client data every few seconds.

---

## AiMesh (multi-AP) setup

If you have multiple ASUS devices in an AiMesh topology, you only need to configure the **main (primary) AiMesh router**. Widemap discovers satellite nodes automatically via the AiMesh API.

---

## Troubleshooting

**Cannot reach the web admin after switching to AP mode**
- The IP address changes after switching to AP mode. Use `show arp` on the Yamaha RTX to find the new IP
- Try `http://router.asus.com/` — ASUS may still respond on this hostname

**Authentication fails in Widemap**
- Verify the password by logging in directly at `http://<asus-ap-ip>/`
- Re-enter the password in the Widemap Settings panel

**No WiFi clients appearing**
- Confirm devices are connected to the ASUS AP (not to another access point)
- Check that the ASUS AP IP in Widemap Settings is correct

---

## What Widemap reads from the ASUS AP

- Connected client list: MAC address, IP, connection type (wired / 2.4G / 5G / 6G), RSSI, TX/RX rates
- AiMesh topology: which satellite node each client is connected to
- Widemap does **not** modify any ASUS settings
