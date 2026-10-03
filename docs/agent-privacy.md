# What the EgressView Agent for macOS sends, and where

This page lists the outbound services the macOS agent uses. For
Windows, see [the other one](agent-privacy-windows.md). They are the same
product, but **they read destination names differently**.

> [Japanese / 日本語](agent-privacy.ja.md)

The agent watches outbound connections on your Mac. A tool with that job has to
be specific about its own outbound connections, because "trust us" is not an
answer a person can check.

This page lists the agent's service destinations, why it contacts them, and what
leaves your machine. It is the prose counterpart to the
`PrivacyInfo.xcprivacy` manifest shipped inside both the app and its system
extension.

## The short version

- **Observations are stored on your hardware by default.** Connection metadata
  is written to a store inside the app group container on your Mac. Enrolment
  with your own Hub, optional destination-location lookups, and cloud AI can
  send selected data off-device as described below.
- **There is no developer telemetry.** The agent has no analytics endpoint or
  crash reporter. Optional third-party lookups and cloud AI have separate,
  explicit controls below.
- **Payloads are never read.** The system extension is a content filter that
  passes every flow through unmodified; it records who connected to what, not
  what was said. Where macOS reports a connection's size as zero, the agent
  counts it from packet **headers** instead — see
  [Counting bytes from packet headers](#counting-bytes-from-packet-headers).
- **If you enrol with a Hub, observations go to that Hub — which is yours.**
  You run it. The developer has no access to it.

The host app's `PrivacyInfo.xcprivacy` declares data types that can be retained
by the distribution CDN or optional external providers: other data (including
request and destination IP addresses and connection aggregates), browsing
history (websites in an AI context), other user content (AI questions and
conversation), and user IDs (provider accounts). These are **possible** data
flows, not a claim that all optional services are enabled. The system
extension has a separate manifest with no collected data types: it passes
observations to the host app locally and does not make these external requests.
Sending observations to a Hub that you run yourself is not a transfer to the
developer or an external service operated for the developer.

## Every outbound connection the agent makes

| Host | When | What is sent | What comes back |
|---|---|---|---|
| **Your Hub** (the address you entered) | Only after you enrol, and only if delivery is on | This Mac's host name and observed connection metadata: local/remote addresses and ports, protocol, process name and ID, bundle ID when available, timestamps, byte counts, collector and confidence, and the destination host name when one was observed | Acknowledgement; threat feed data; map locations for addresses you have already observed |
| **`dl.egressview.com`** | Update check on a schedule, and when you press Check for Updates | An HTTPS GET with the agent and OS versions. No identifier, no account, no observation data | A release manifest, and the `.pkg` if you choose to install |
| **`feodotracker.abuse.ch`, `threatfox.abuse.ch`, `urlhaus.abuse.ch`, `www.spamhaus.org`** | **Only if you turn on direct feed download**, which is off when a Hub supplies feeds | An ordinary HTTPS GET for the whole public list. **Your observations are not sent** — matching happens on your Mac, against the downloaded list | The public indicator lists |
| **`download.maxmind.com`** | Only if you configure a local GeoLite2 country table | Your MaxMind account ID and licence key; no observed destination address | The GeoLite2 database |
| **`ipwho.is`** | Only if you enable fallback location lookups | Observed destination IP addresses, up to 500 a day | Location for each queried address |
| **`api.openai.com`, `api.anthropic.com`** | Only if you configure that cloud AI provider and submit a question | The bounded context shown in the preview, your question, and conversation context | The model's answer |

These are the configured service categories, not an allowlist of every network
hostname: for example, a download host may redirect to a CDN. Report an
unexpected connection so its purpose can be checked.

### The one thing this table cannot hide

Contacting `dl.egressview.com` reveals your IP address to that host's CDN, the
same way visiting any website does, and CloudFront writes access logs. That is
a property of making an HTTPS request at all, not something the agent adds. It
is listed here because a privacy page that only mentions the flattering facts is
not worth reading.

The request includes the agent and OS versions in its User-Agent, but no
installation ID, account, or observation data. The CDN's access log retains
the requester's IP address; absence of an installation ID does not make that
log anonymous.

Cloud AI is opt-in, but that does not mean its inputs are transient. OpenAI's
Responses API retains response state by default, and Anthropic's API normally
retains inputs and outputs after processing. The context can include visited
websites and connection aggregates; a question can contain whatever the user
types. The host manifest therefore declares these possible data types even if
the user never enables cloud AI. The `ipwho.is` fallback sends observed
destination IPs only when enabled; its retention policy has not been verified,
so the manifest conservatively covers those IPs too. The MaxMind account ID
is sent only when the user configures a local GeoLite2 download.

Apple's "collected data" definition depends on whether the developer or a
third-party partner can access readable data beyond the time needed to serve
the request; merely making a network request is not sufficient. The manifest
is not a per-provider retention guarantee. For the current policies, see
[Apple's App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/),
[OpenAI's API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint),
and [Anthropic's retention policy](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data).

### The fields sent to a Hub

The table above says what is sent in words. These are the JSON field names
actually sent. **The macOS and Windows agents send the same ones.**

`schemaVersion`, `batchId`, `sentAt`, `agent` (`hostName`, `platform`, `osVersion`, `agentVersion`), `observations` (`observationId`, `networkProtocol`, `localAddress`, `localPort`, `remoteAddress`, `remotePort`, `processID`, `processName`, `bundleID`, `firstObservedAt`, `lastObservedAt`, `bytesIn`, `bytesOut`, `collector`, `confidence`)

`remoteHostname` is added only when the Hub advertises support for it. The
credential is sent as a Bearer token to that Hub.

This is the same list the agent shows before enrolling. Enrolment cannot start
until you confirm you have read it.

## Counting bytes from packet headers

macOS reports how many bytes each connection carried when it closes, but for
connections made through Network.framework — which includes URLSession and so
many apps, and the QUIC (HTTP/3) connections they make — that report
is zero in both directions even when megabytes moved. To record those
connections' real size, the system extension also runs a **packet filter**.

What it does, and what it does not:

- **It reads headers, not contents.** For each packet it reads the IP header
  and the TCP or UDP header: protocol, source and destination address and
  port, and lengths. From those it computes how many payload bytes the packet
  carried. The bytes after the headers are not read, copied or stored.
  Encrypted traffic stays encrypted; nothing is decrypted.
- **It keeps numbers, in memory, briefly.** Per connection (protocol,
  addresses and ports, as seen from this Mac) it keeps four numbers — bytes
  and packets in each direction — in the system extension's memory. When the
  connection closes, the count is taken and removed. Entries no packet has
  touched for ten minutes are dropped, and at most 65,536 are kept.
- **It is used only where macOS has no number.** The count replaces the
  report only when macOS says zero both ways. A connection macOS counts keeps
  macOS's number.
- **Nothing new leaves the Mac.** The result is the same `bytesIn` /
  `bytesOut` fields the agent already records and, if you enrol, sends to your
  Hub. No packet, header or address list is written to disk, logged or sent.
- **Every packet passes.** The filter never blocks, delays or changes a
  packet; it allows each one after reading its headers.

The count is of payload bytes, so it is close to, but not the same as, the
size of what an app downloaded: for a 78,450,688-byte file over QUIC it
recorded 79,840,999 bytes, the difference being QUIC's own framing and
encryption overhead. Over TCP, on connections macOS also counts, it matched
macOS's figure exactly in most cases (79 of 107 in a 30-minute sample) and
within 0.1 % in total.

## Reading the destination name, and the one thing that is decrypted

Off unless you turn it on. The name it recovers is used in the local history
and on this Mac's own screens, and **is also sent to your Hub when that Hub
says it accepts one** (P3-14 stage 2, agent 0.5.59 and later). An older Hub
is never sent one: the agent asks first, and sends nothing extra if there is
no answer.

Over TLS, the client says where it is going in the clear, before any key is
agreed. Nothing is decrypted to read that.

**Over QUIC that message is encrypted, and this decrypts it.** Saying otherwise
would be false, and the claim is the whole reason the setting is worth
trusting. What makes it possible is that the keys for a QUIC *Initial* packet
are derived from the connection ID, which travels in the clear, by a procedure
published in RFC 9001 — **anyone watching the network can do this.** It reveals
nothing that was protected from an observer.

It reaches the first message only. Every later packet is protected with keys
derived from the TLS handshake, which an observer does not have. **The agent
cannot read a QUIC conversation and never will be able to.**

A browser's ClientHello often does not fit in one Initial packet and **arrives
in two**, so reading continues until that first message is complete and stops
there. Measured 2026-08-24: 27 flows produced 56 callbacks, 28 of them the
second packet. **What is read is still the first message; the reach has not
grown.**

### A name that was read is not always the destination

On a connection using **ECH (Encrypted Client Hello)**, the name given in the
clear is a **public name shared by many sites** — `cloudflare-ech.com`, for
example. The real destination is encrypted inside it and **cannot be read, by
anyone watching the network.**

**The agent also cannot tell whether a given name is one of these.** Chrome
sends the same extension on connections that do not use ECH (GREASE), so an
observer cannot distinguish real ECH from GREASE — **that is what ECH is for.**
Marking names as uncertain on that basis would put a wrong mark on the great
majority of names that are exactly what they appear to be.

It is rare in practice: on this Mac, 8 of 521,575 named observations carried
`cloudflare-ech.com` — 0.002%. **Rare is not a reason to leave it unwritten:
without this, such a name reads as the place the traffic went.**

## Threat matching happens on your Mac

The agent does not ask anybody whether an address is malicious. It downloads
(or receives from your Hub) the public indicator lists and compares locally.
**The addresses you talked to are never sent to a threat-intelligence provider**,
because that would hand the thing being protected to a third party in order to
protect it.

## Locations on the globe

The globe places destinations you have already observed. It can use your
**own Hub** at `api/agent/geo-cache` or a locally downloaded GeoLite2 country
table. If you opt in to fallback lookups, an unresolved destination IP can be
sent to `ipwho.is`. Without a location source, the globe cannot place it;
the agent does not silently query a third party.

## Required-reason API declarations

Apple asks apps to declare a reason for a small set of APIs that have been used
for fingerprinting. The agent declares two categories, and this is what it uses
them for:

| Category | Reason code | What the agent actually does |
|---|---|---|
| User defaults | `CA92.1` | Reads and writes its own settings — window state, refresh rate, language |
| User defaults | `1C8F.1` | Shares settings with the system extension through the app group both belong to |
| File timestamp | `C617.1` | Reads the **size** of files it wrote itself: the observation journal and store in the app group container, and a downloaded update package in the app's temporary directory |

The agent does not use the disk-space, system-boot-time, or active-keyboard
categories. A repository test fails the build if a call to one of those appears
in the source without a matching declaration, so this table cannot quietly go
stale.

## What you can check yourself

Everything above is observable without trusting this page:

```bash
# The manifest inside the installed app
plutil -p "/Applications/EgressView Agent.app/Contents/Resources/PrivacyInfo.xcprivacy"

# The same manifest inside the system extension
plutil -p "/Applications/EgressView Agent.app/Contents/Library/SystemExtensions/com.egressview.agent.filter.systemextension/Contents/Resources/PrivacyInfo.xcprivacy"

# That the app is notarised by Apple and unmodified since signing
spctl -a -vvv -t install "/Applications/EgressView Agent.app"
codesign --verify --deep --strict --verbose=2 "/Applications/EgressView Agent.app"
```

And, fittingly, you can point EgressView at the Mac running the agent and watch
what the agent itself connects to.
