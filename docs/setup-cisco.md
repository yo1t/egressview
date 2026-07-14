# Cisco IOS — SSH Setup Guide

This guide explains how to prepare a formally supported Cisco IOS router for EgressView.

> **Formal support:** Validated on a C841M-4X-JSEC/K9 running IOS 15.5(3)M9, including SSH, enable, NAT/ARP/NDP, verbose output, TOFU, and automatic reconnect.

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

EgressView prefers `show ip nat translations verbose` when the device supports it: the per-entry `create` and `left` ages give each session an accurate start time and remaining TTL. If the verbose keyword is rejected, EgressView falls back to the plain command automatically.

```text
show ip nat translations verbose
```

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

If an older IOS release reports a key-exchange error, first enable only `diffie-hellman-group14-sha1`. EgressView supports this compatibility method but intentionally does not enable the weaker `group1-sha1`.

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

Open Settings → `L3/L4`, add a router row, and fill in:

| Field | Value |
|-------|-------|
| Cisco IOS IP | Router LAN IP |
| Username | SSH login username |
| Password | SSH login password |
| Enable password | Optional; required only if your login lands in non-privileged mode |

Use **Connect & Auto-detect** first, then save the settings if the checks succeed.

You can enable up to 10 Yamaha RTX and Cisco IOS routers in any combination. Give every physical or logical router a unique name; EgressView assigns and persists a stable router ID, polls each router independently, and retains all observing router IDs when multiple routers report the same connection.

---

## Current limitations

- Physical validation currently covers C841M-4X-JSEC/K9 / IOS 15.5(3)M9; other IOS platforms depend on CLI compatibility
- `enable` password flows may differ by prompt style and privilege model
- NAT command output formats can vary between models
- Multi-router automation covers 10 mixed fake routers, concurrency capped at 3, one-router failure isolation, and deduplication
- Physical supplementary testing used one Cisco and one Yamaha, each registered twice under distinct router IDs; this does not validate multiple distinct same-vendor units
- EgressView observes router state but does not configure or control HSRP/VRRP, synchronize NAT state, or perform failover

Reports from other models and redacted output fixtures are welcome.
