# What the EgressView Agent for macOS sends, and where

> [Japanese / 日本語](agent-privacy.ja.md)

The agent watches outbound connections on your Mac. A tool with that job has to
be specific about its own outbound connections, because "trust us" is not an
answer a person can check.

This page lists **every host the agent contacts, why, and what leaves your
machine when it does.** It is the prose counterpart to the
`PrivacyInfo.xcprivacy` manifest shipped inside both the app and its system
extension.

## The short version

- **Observations stay on your hardware.** Connection metadata is written to a
  store inside the app group container on your Mac.
- **The developer receives none of it.** There is no analytics endpoint, no
  crash reporter, and no telemetry of any kind.
- **Payloads are never read.** The system extension is a content filter that
  passes every flow through unmodified; it records who connected to what, not
  what was said.
- **If you enrol with a Hub, observations go to that Hub — which is yours.**
  You run it. The developer has no access to it.

This is why `NSPrivacyCollectedDataTypes` in the manifest is an **empty array**
rather than a short list. Apple defines collection as transmitting data off the
device where the developer or a third party can access it. By that definition
the agent collects nothing.

## Every outbound connection the agent makes

| Host | When | What is sent | What comes back |
|---|---|---|---|
| **Your Hub** (the address you entered) | Only after you enrol, and only if delivery is on | Connection metadata observed on this Mac: process, remote address and port, byte counts, timestamps. **Never payload bytes** | Acknowledgement; threat feed data; map locations for addresses you have already observed |
| **`dl.egressview.com`** | Update check on a schedule, and when you press Check for Updates | An ordinary HTTPS GET. No identifier, no account, no observation data | A release manifest, and the `.pkg` if you choose to install |
| **`feodotracker.abuse.ch`, `threatfox.abuse.ch`, `urlhaus.abuse.ch`, `www.spamhaus.org`** | **Only if you turn on direct feed download**, which is off when a Hub supplies feeds | An ordinary HTTPS GET for the whole public list. **Your observations are not sent** — matching happens on your Mac, against the downloaded list | The public indicator lists |

There is no fourth category. If you see the agent connecting somewhere not on
this table, that is a bug worth reporting.

### The one thing this table cannot hide

Contacting `dl.egressview.com` reveals your IP address to that host's CDN, the
same way visiting any website does, and CloudFront writes access logs. That is
a property of making an HTTPS request at all, not something the agent adds. It
is listed here because a privacy page that only mentions the flattering facts is
not worth reading.

Nothing in that request identifies you beyond the request itself: there is no
installation ID, no account, and no observation data attached.

## Reading the destination name, and the one thing that is decrypted

Off unless you turn it on, and it changes nothing about what leaves this Mac —
the name it recovers **stays here**; the Hub is never sent a host name.

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

The globe places destinations you have already observed. Those lookups go to
**your own Hub** at `api/agent/geo-cache`, not to a geolocation service, and the
results are cached. If you have not enrolled with a Hub, the globe has nothing
to place and says so.

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
