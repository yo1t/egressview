# Cisco IOS — SSH Setup Guide

This guide explains how to prepare a Cisco IOS router for EgressView.

> **Status:** Cisco router support in EgressView is currently a **sample implementation**. It has **not** yet been validated on physical Cisco hardware. Use it as a beta path until real-device testing is completed and the feature is promoted to a formal release.

---

## What EgressView expects

EgressView currently expects a Cisco IOS device that can:

- accept SSH login
- run `show ip nat translations`
- optionally enter privileged EXEC mode with `enable`
- expose ARP information for local-device correlation

If your device, IOS version, or privilege model behaves differently, auto-detection or polling may fail.

If you find an error on real hardware, please open a GitHub Issue with:

- router model
- IOS version
- whether `enable` is required
- redacted output from `show ip nat translations`
- redacted output from `show arp`
- relevant EgressView logs

Pull requests are especially helpful when they include a redacted fixture and parser test for the failing output format.

---

## Step 1 — Enable SSH access

Example baseline configuration:

```text
hostname edge-router
ip domain-name home.local
crypto key generate rsa modulus 2048
ip ssh version 2

username egressview privilege 15 secret yourpassword

line vty 0 4
 login local
 transport input ssh
```

If you prefer a lower-privilege user plus `enable`, configure that according to your operational policy and provide the enable password in EgressView.

---

## Step 2 — Verify NAT visibility

EgressView needs to read the NAT translation table. Confirm that this command works:

```text
show ip nat translations
```

If the command returns active translations, the basic data path is present.

If the command is unavailable, empty under load when you expect traffic, or blocked by privilege level, EgressView will not be able to collect L3/L4 session data reliably.

---

## Step 3 — Verify ARP visibility

EgressView also benefits from ARP visibility so it can relate sessions back to local devices:

```text
show arp
```

If ARP output is unavailable or restricted, connection records may still appear, but local-device enrichment can be incomplete.

---

## Step 4 — Test the same login path manually

From the machine running EgressView:

```bash
ssh egressview@192.168.1.1
```

Then confirm:

```text
terminal length 0
show ip nat translations
show arp
```

If your environment requires `enable`, test that flow too:

```text
enable
```

---

## Step 5 — Enter the settings in EgressView

Open Settings → `L3/L4` and fill in:

| Field | Value |
|-------|-------|
| Cisco IOS IP | Router LAN IP |
| Username | SSH login username |
| Password | SSH login password |
| Enable password | Optional; required only if your login lands in non-privileged mode |

Use **Connect & Auto-detect** first, then save the settings if the checks succeed.

---

## Current limitations

- Real-device validation is still pending
- Behavior may vary by IOS version and platform
- `enable` password flows may differ by prompt style and privilege model
- NAT command output formats can vary between models

If you try this on a real Cisco router and it works or fails in a specific way, that feedback is especially useful for moving the feature from sample implementation to formal release.
