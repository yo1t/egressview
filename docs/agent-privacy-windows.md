# What the EgressView Agent for Windows sends, and where

This page lists **every** outbound connection the Windows agent makes.
For macOS, see [the other one](agent-privacy.md). They are the same product,
but **they read destination names differently**, and that difference is the
centre of this page.

## The short version

- **Observations stay on this PC.** Connection metadata is written to a SQLite
  database on this machine.
- **The developer receives none of it.** There is no analytics endpoint, no
  crash reporter, and no telemetry of any kind.
- **Payloads are never read.** Monitoring is done through ETW (Event Tracing
  for Windows), which **never hands over packet contents**. It records who
  connected to what, not what was said.
- **If you enrol with a Hub, observations go to that Hub — which is yours.**
  You run it. The developer has no access to it.

## Every outbound connection the agent makes

| Host | When | What is sent | What comes back |
|---|---|---|---|
| **Your Hub** (the address you entered) | Only after enrolling, and only while delivery is enabled | This PC's host name and the connection metadata it observed | An acknowledgement, threat feed data, map positions for addresses already observed |
| **`dl.egressview.com`** | On the periodic update check, and when you press "Check for updates" | An ordinary HTTPS GET. No identifier, no account, no observations | The release manifest |
| **`feodotracker.abuse.ch` / `threatfox.abuse.ch` / `urlhaus.abuse.ch` / `www.spamhaus.org`** | **Only if you enable public feed downloads** | An ordinary HTTPS GET for the whole public list. **None of your observations are sent** | The published indicator lists |
| **`download.maxmind.com`** | **Only if you enable the country table** | Your MaxMind account ID and licence key. **No observed destination is sent** | The GeoLite2-Country database |
| **`ipwho.is`** | **Only if you choose "Ask the Hub, then ipwho.is"** | **The IP addresses of destinations you observed**, at most 500 a day | The country and coordinates for that address |
| **`api.openai.com` / `api.anthropic.com`** | **Only if you enable a cloud AI provider and confirm each question** | Exactly the bounded preview shown on screen | The answer |

There is no seventh category. **If you ever see the agent connect somewhere
that is not in this table, that is a bug worth reporting.**

### Two things this table cannot hide

**First.** The `ipwho.is` row is the only one that **sends a destination you
observed out of this network.** No other row does. It is not the default: the
settings screen offers it as one of three choices, in a warning colour, with
the sentence saying so and the remaining daily allowance beside it. Unless you
choose it, no destination of yours leaves this PC.

**Second.** Connecting to `dl.egressview.com` tells that host's CDN your IP
address, exactly as visiting any website does, and CloudFront writes an access
log. **That is a property of making an HTTPS request at all, not something the
agent adds.** It is written here because a privacy page that only lists the
convenient facts is not worth reading.

Nothing in that request identifies you beyond the request itself. There is no
installation ID, no account, and no observations attached.

### The fields sent to a Hub

These are the JSON field names actually sent. **The macOS and Windows agents
send the same ones.**

`schemaVersion`, `batchId`, `sentAt`, `agent` (`hostName`, `platform`,
`osVersion`, `agentVersion`), `observations` (`observationId`,
`networkProtocol`, `localAddress`, `localPort`, `remoteAddress`, `remotePort`,
`processID`, `processName`, `bundleID`, `firstObservedAt`, `lastObservedAt`,
`bytesIn`, `bytesOut`, `collector`, `confidence`)

`remoteHostname` is added only when the Hub advertises support for it. The
credential is sent as a Bearer token to that Hub.

This is the same list the agent shows before enrolling. **Enrolment cannot
start until you confirm you have read it.**

## How destination names are read — nothing is decrypted

**This is the largest difference from the macOS agent.**

The macOS agent reads the first message of a connection. Over TLS that message
is in the clear, but **over QUIC it is encrypted and the macOS agent decrypts
that one packet**. It does so because macOS tells applications almost nothing
about where a connection is going, and without it no browser destination could
be named at all.

**The Windows agent decrypts nothing. It never reads a packet's contents.**

Instead it reads the events Windows' own DNS client writes to ETW
(`Microsoft-Windows-DNS-Client`, event 3008) and correlates the name that was
looked up with the addresses in the answer, inside this PC. **What it reads is
metadata Windows itself emitted, not the content of your traffic.**

### Is that enough?

Measured on this PC (2026-09-20, the last 24 hours):

| | |
|---|---|
| Destinations reached by chrome | 30 |
| Named | **24 (80%)** |

Four of the six unnamed were `224.0.0.251` and `ff02::fb` — **mDNS multicast
addresses, which have no DNS name to find.**

For comparison, the macOS privacy note puts the same measurement this way:
"About half of connections come from applications that do not, **including
every browser measured**." **The Windows agent gets the result above without
decrypting anything.**

### Where this approach stops working

**If a browser uses DNS over HTTPS (Secure DNS), this does not work.** The
lookup never reaches Windows' DNS client, so no ETW event is written, and the
destination stays an address. If you have Secure DNS enabled in Chrome or
Edge, the 80% above will be lower.

**Threat matching by address, locations and countries are unaffected**, because
those are derived from the address.

This reading is **on by default** and can be switched off in settings. With it
off, destinations are shown as addresses and threat matching by domain has
nothing left to match.

## Threat matching happens on this PC

Threat feeds arrive **as whole lists** and the matching happens here. Whether
the feeds came from a Hub or from the public sources, **the check itself never
leaves this machine.** There is no path that asks anyone "is this address
dangerous?".

## Positions on the globe

Three paths can place a destination on the map. **Only the first two are used
by default.**

1. **The Hub's location cache** — fetched whole, once a day. **Your
   destinations are not part of that request.**
2. **A country table on this PC** (optional) — MaxMind's GeoLite2-Country kept
   on this machine and read locally. **Only your account details go to
   MaxMind; no destination does.** It gives countries only, so it cannot place
   a pin on the globe.
3. **A lookup at `ipwho.is`** (optional, off by default) — **sends the IP
   addresses of destinations you observed.** Only if you choose it.

Even when 3 is chosen, **this network's own addresses are never sent**:
`10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`, loopback, link-local,
carrier-grade NAT, multicast and the documentation ranges. Nothing outside can
place them, and sending them would hand over the shape of your own network for
nothing.

## What you can check yourself

All of the above can be observed without trusting this page.

The agent records its own connections. Filter for
`EgressView.Agent.Service` and `EgressView.Agent.Ui` and compare what you see
against the table above. **This tool watches itself too.**

With an outside tool:

```powershell
Get-NetTCPConnection -State Established |
  Where-Object { $_.OwningProcess -in (Get-Process EgressView.Agent.* ).Id }
```

## About signing

**The Windows builds are not currently code-signed.** SmartScreen will warn
that the publisher is unknown when you download one.

Check it against the SHA-256 published on the download page.

```powershell
Get-FileHash -Algorithm SHA256 $HOME\Downloads\EgressView-Agent-Windows-<version>-<arch>.msi
```

This is not a substitute for a signature. **While the builds are unsigned, the
in-app update will not install anything** — it refuses what it cannot verify.
The agent still tells you when a newer version exists; downloading and running
it is yours to do.
