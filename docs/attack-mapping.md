# What EgressView can and cannot tell you, mapped to MITRE ATT&CK

[日本語](attack-mapping.ja.md)

This page is for you if you already think in [MITRE ATT&CK](https://attack.mitre.org/) terms and want to know, before installing, which signs EgressView can show you and which it cannot. Each row says which technique a feature relates to, what you would see, what it needs, how far it has been checked, and when it misses.

**You do not need this page** to use EgressView. If you just want to see where your traffic goes, start with the [overview](../README.md).

## Read this first

- **EgressView points at things worth checking. It does not decide that something is malware, and it does not stop anything.** Backups, cloud sync, OS updates and first syncs look the same as several of the signs below.
- **A row here means "EgressView can show a sign related to this technique."** It does not mean EgressView detects every use of the technique. MITRE has not evaluated or endorsed EgressView.
- **It is not a DLP, EDR or firewall.** It reads connection metadata only, never packet contents, so it cannot tell what was sent, whether it was sensitive, or whether an attempt succeeded.

## Signs EgressView can show today

"Hub" means EgressView Hub. "Agent" means EgressView Agent for Mac or Windows. "Router" means a supported Yamaha RTX or Cisco IOS router read by the Hub.

| What you would see | Related ATT&CK technique | What it needs | Rule | Checked so far | Misses |
|---|---|---|---|---|---|
| **A connection to a known-bad destination** (threat notification) | [T1071 Application Layer Protocol](https://attack.mitre.org/techniques/T1071/) (known command-and-control servers); [T1105 Ingress Tool Transfer](https://attack.mitre.org/techniques/T1105/) (known malware distribution hosts) | Hub or Agent. The abuse.ch Feodo Tracker, URLhaus and ThreatFox lists and Spamhaus DROP | The destination address or host is on a list | Automated tests (`test/unit/threat-intel.test.js`, Mac `ThreatMatcherTests`); in use on the maintainer's own network | Anything not on the lists yet, including new infrastructure. Some matches on shared services, such as a release download host, are shown as low confidence rather than as a compromise |
| **A device calling the same destination at a steady interval** ("Beacon candidates" in the Hub) | [T1071 Application Layer Protocol](https://attack.mitre.org/techniques/T1071/) (regular command-and-control check-ins) | Hub with a router. Not computed from Agent data | At least 4 connections between the same source, destination, port and protocol, with a median gap of 1 minute to 4 hours and a coefficient of variation of 0.5 or less | Automated tests (`test/unit/beacon-detector.test.js`) | Check-ins with random gaps (jitter), check-ins faster than 1 minute or slower than 4 hours, and traffic that does not pass the router. Many legitimate apps poll at steady intervals; candidates are listed, not notified |
| **Much more sent in 15 minutes than this computer usually sends** ("Unusual outbound traffic" notification) | [T1041 Exfiltration Over C2 Channel](https://attack.mitre.org/techniques/T1041/) (only the large-volume part) | Agent | A finished 15-minute window above the largest of 100 MiB, 3× the usual median, and the usual median + max(16 MiB, 6 × MAD). Judged only after 24 hours of history, and only for windows where at least 80% of connections had a byte count | Automated tests (Mac `OutboundAnomalyDetectorTests`); on a real Mac it fired on ordinary use and notified (2026-09) | Anything under the threshold, sending split over many windows, and traffic without a byte count (see "Where EgressView cannot see" below) |
| **An app sending to a destination it has not used before, or more than usual to one it has** ("Worth a look (last 14 days)" in the Agent's Insights) | [T1567 Exfiltration Over Web Service](https://attack.mitre.org/techniques/T1567/) and [T1030 Data Transfer Size Limits](https://attack.mitre.org/techniques/T1030/), as signs to look into | Agent (Mac 0.5.139 or later, Windows 0.1.165 or later) | After 168 hours of monitoring: a new app-and-destination pair that sent 1 MiB or more in its first 7 days; a known pair that sent 10 MiB or more in a day and at least 5× its usual 90th percentile; or the whole computer sending more than 1.5× its usual 99th percentile in 24 hours | Shared test cases (`test/fixtures/outbound-candidates-cases.json`) pass on both; the list matched a replay of real data on one Mac. **Not yet checked on a real PC:** lists of 11 or more on a Mac, small windows, and the Windows list once learning finished | New pairs under 1 MiB a week, known pairs under 10 MiB a day, browsers and virtual machines (left out on purpose), LAN destinations, and sending spread so that each pair stays under the limits. Not notified, not sent to the Hub. On one Mac, about one candidate a day appeared, all from apps the owner uses |
| **A program on a computer scanning the LAN** ("LAN scanning" notification) | [T1046 Network Service Discovery](https://attack.mitre.org/techniques/T1046/); [T1018 Remote System Discovery](https://attack.mitre.org/techniques/T1018/) | Hub with Agents sending to it | In 2 minutes, one program connects to 30 or more LAN addresses, or to 10 or more ports on one LAN address | Automated tests (`test/unit/lan-scan-detector.test.js`); end-to-end on a real Mac and a real Windows PC with a deliberate sweep | Slower scans, scans from devices without an Agent, and scans of addresses outside private ranges |
| **Another LAN device probing this computer** ("LAN scanning" notification naming the sender) | [T1046 Network Service Discovery](https://attack.mitre.org/techniques/T1046/) | Hub with Agents sending to it. On a Mac, packet-header counting must be on (off by default) | One LAN sender reaches 10 or more of this computer's ports in 2 minutes | Automated tests (Mac `InboundProbeTests`); end-to-end on a real Mac and a real Windows PC, TCP and UDP | Slower probes, probes of only a few ports, and every probe on a Mac with packet-header counting off |
| **An Agent stopped reporting while its computer kept using the network** ("No reports from an Agent" notification) | [T1562.001 Impair Defenses: Disable or Modify Tools](https://attack.mitre.org/techniques/T1562/001/), as one possible cause | Hub with a router and Agents | Nothing from the Agent for 15 minutes while the router records 3 or more new connections from that computer | Automated tests (`test/unit/agent-silence-detector.test.js`); checked against production data that ordinary quiet periods (sleep, shutdown) stay quiet. No real outage has been caught yet | Hubs without a router. The usual causes are an app that did not come back after an update or a crash, not an attack |

## Where EgressView cannot see

- **Computers without an Agent and traffic that skips the router.** The router sees devices behind it but not which app sent what; traffic inside the LAN usually never reaches the router.
- **Byte counts on a Mac.** For many connections macOS reports no byte count unless packet-header counting is turned on. A 15-minute window in which fewer than 80% of connections had a byte count is skipped, on Mac and Windows alike, so such traffic cannot raise the volume-based signs above.
- **When the Agent is not running**: stopped, asleep, or not yet started after an update. The Agent also judges only on its own computer; nothing is compared across computers.
- **Hub delivery is opt-in.** Signs that the Hub computes (LAN scanning, probes, Agent silence) need Agents sending to it.
- **Contents.** Encrypted or not, EgressView never reads what was sent.
- **Ordinary work that looks the same**: backups, cloud sync, large uploads, updates and new apps.

## Planned, not available yet

- Comparing outbound traffic across several Agents on the Hub. Until it ships and is checked on real machines, nothing on this page claims it.

## Related pages

- [Manual threat investigation](manual-threat-investigation.md): what to do when you get a threat notification.
- [What Agent for Mac sends](agent-privacy.md) · [What Agent for Windows sends](agent-privacy-windows.md)
