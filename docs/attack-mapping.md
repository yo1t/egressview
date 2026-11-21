# What EgressView can and cannot tell you, mapped to MITRE ATT&CK

[日本語](attack-mapping.ja.md)

If you work with [MITRE ATT&CK](https://attack.mitre.org/), this page lists the signs EgressView can show today, the technique each one relates to, and the cases each one misses. To just see where your traffic goes, start with the [overview](../README.md) instead.

EgressView does not decide that something is malware, and it does not block anything. It reads connection metadata, not packet contents, so it cannot tell what was sent or whether an attack worked. Backups, cloud sync and updates can look like several of the signs below. A technique listed here means EgressView can show a sign related to it, not that it detects every use of it. MITRE has not evaluated EgressView. It does not replace a DLP, EDR or firewall.

## The signs at a glance

"Router" means a Yamaha RTX or Cisco IOS router that the Hub reads.

| What you see | ATT&CK | What it needs |
|---|---|---|
| [Connection to a listed bad destination](#connection-to-a-listed-bad-destination) | T1071, T1105 | Hub or Agent |
| [Beacon candidates](#beacon-candidates) | T1071 | Hub and a router |
| [Unusual outbound traffic](#unusual-outbound-traffic) | T1041 | Agent |
| [Worth a look (last 14 days)](#worth-a-look-last-14-days) | T1567, T1030 | Agent |
| [LAN scanning by a program on this computer](#lan-scanning-by-a-program-on-this-computer) | T1046, T1018 | Hub and Agents |
| [Another LAN device probing this computer](#another-lan-device-probing-this-computer) | T1046 | Hub and Agents |
| [No reports from an Agent](#no-reports-from-an-agent) | T1562.001 | Hub, a router and Agents |

## Connection to a listed bad destination

Related: [T1071 Application Layer Protocol](https://attack.mitre.org/techniques/T1071/) for known command-and-control servers, and [T1105 Ingress Tool Transfer](https://attack.mitre.org/techniques/T1105/) for known malware download hosts.

- Rule: the destination address or host name is on abuse.ch Feodo Tracker, URLhaus or ThreatFox, or on Spamhaus DROP. The Hub and both Agents check this and notify.
- Checked: automated tests (`test/unit/threat-intel.test.js`, Mac `ThreatMatcherTests`). Running on the maintainer's own network.
- Misses: anything not on the lists yet. A match on a shared service, such as a release download host, is shown as low confidence.

## Beacon candidates

Related: [T1071 Application Layer Protocol](https://attack.mitre.org/techniques/T1071/), for regular check-ins to a command-and-control server.

- Rule: at least 4 connections with the same source, destination, port and protocol, a median gap between 1 minute and 4 hours, and a coefficient of variation of 0.5 or less. Computed from router data only. Candidates are listed in the Hub; there is no notification.
- Checked: automated tests (`test/unit/beacon-detector.test.js`).
- Misses: check-ins with random gaps, gaps under 1 minute or over 4 hours, and traffic that does not pass the router. Plenty of normal apps also check in on a schedule.

## Unusual outbound traffic

Related: the large-volume part of [T1041 Exfiltration Over C2 Channel](https://attack.mitre.org/techniques/T1041/).

- Rule: a finished 15-minute window sends more than all of these: 100 MiB, 3 times this computer's median, and the median plus the larger of 16 MiB and 6 × MAD. The Agent starts judging after 24 hours of history and skips windows where fewer than 80% of connections had a byte count. It notifies.
- Checked: automated tests (Mac `OutboundAnomalyDetectorTests`). On a Mac in everyday use, it fired and notified in September 2026.
- Misses: anything below the threshold, sending spread over many windows, and traffic with no byte count (see [What EgressView cannot see](#what-egressview-cannot-see)).

## Worth a look (last 14 days)

Related, as leads to look into: [T1567 Exfiltration Over Web Service](https://attack.mitre.org/techniques/T1567/) and [T1030 Data Transfer Size Limits](https://attack.mitre.org/techniques/T1030/).

- Rule: after 168 hours of monitoring, any of these: an app and destination pair seen for the first time sends 1 MiB or more in its first 7 days; a known pair sends 10 MiB or more in a day and at least 5 times its usual 90th percentile; the whole computer sends more than 1.5 times its usual 99th percentile in 24 hours. Shown in the Agent's Insights tab (Mac 0.5.139 or later, Windows 0.1.165 or later). No notification, and nothing is sent to the Hub.
- Checked: both Agents pass the shared cases in `test/fixtures/outbound-candidates-cases.json`. On one Mac the list matched a replay of the same data. Not yet checked on a real machine: a Mac list of 11 or more, small windows, and a Windows list after learning finishes.
- Misses: new pairs under 1 MiB a week, known pairs under 10 MiB a day, browsers and virtual machines (left out on purpose), LAN destinations, and sending split so that each pair stays under the limits.
- On one Mac over nine days, about one item a day appeared. All came from apps the owner uses.

## LAN scanning by a program on this computer

Related: [T1046 Network Service Discovery](https://attack.mitre.org/techniques/T1046/) and [T1018 Remote System Discovery](https://attack.mitre.org/techniques/T1018/).

- Rule: within 2 minutes, one program connects to 30 or more LAN addresses, or to 10 or more ports on one LAN address. The Hub works this out from what Agents send it, and notifies.
- Checked: automated tests (`test/unit/lan-scan-detector.test.js`). A deliberate sweep was caught end to end on a Mac and on a Windows PC.
- Misses: slower scans, scans from devices with no Agent, and addresses outside the private ranges.

## Another LAN device probing this computer

Related: [T1046 Network Service Discovery](https://attack.mitre.org/techniques/T1046/).

- Rule: one LAN sender reaches 10 or more of this computer's ports within 2 minutes. The Hub notifies and names the sender. On a Mac this needs packet-header counting, which is off by default.
- Checked: automated tests (Mac `InboundProbeTests`). Caught end to end on a Mac and on a Windows PC, over TCP and UDP.
- Misses: slower probes, probes of only a few ports, and any probe of a Mac with packet-header counting off.

## No reports from an Agent

Related, as one possible cause: [T1562.001 Impair Defenses: Disable or Modify Tools](https://attack.mitre.org/techniques/T1562/001/).

- Rule: the Agent sends nothing for 15 minutes while the router records 3 or more new connections from that computer. The Hub notifies.
- Checked: automated tests (`test/unit/agent-silence-detector.test.js`). Production data showed that sleep and shutdown do not trigger it. It has not yet caught a real outage.
- Misses: everything on a Hub without a router. In practice the usual cause is an app that did not restart after an update or a crash, not an attack.

## What EgressView cannot see

- Computers with no Agent, and traffic that never passes the router. Traffic between devices on the LAN usually stays off the router. The router also cannot tell which app sent something.
- Byte counts for many connections on a Mac, unless packet-header counting is on. The volume-based signs skip such traffic on Mac and Windows alike.
- Anything while the Agent is stopped, asleep, or not yet back after an update. Each Agent judges only its own computer.
- Signs the Hub works out (LAN scanning, probes, silent Agents) when Agents do not send to it. Sending is opt-in.
- What was sent. EgressView never reads contents, encrypted or not.
- The difference between an attack and ordinary work such as backups, cloud sync, large uploads, updates and new apps.

## Planned

Comparing outbound traffic across several Agents on the Hub. This page will not claim it until it ships and has been checked on real machines.

## Related pages

- [Manual threat investigation](manual-threat-investigation.md): what to do after a threat notification
- [What Agent for Mac sends](agent-privacy.md) · [What Agent for Windows sends](agent-privacy-windows.md)
