# EgressView Agent for macOS

Your router shows you what leaves the house. It cannot show you **which app on
your Mac** sent it. This agent fills that gap: it reports the process behind each
outbound connection to your EgressView Hub, so a connection to an address you do
not recognise comes with the name of the program that made it.

It reads connection metadata only — addresses, ports, process names. **It never
reads payloads, never decrypts traffic, and never blocks anything.** Byte counts
are reported as unavailable rather than guessed at.

It also shows you that traffic: where it went on a globe, which application sent
it where, when it happened, and whether the destination appears on a threat
feed. **The threat check happens on your Mac.** Asking a service "is this address
dangerous?" would tell that service exactly which addresses worry you, so the
indicators come here and the questions never leave.

The host app and its Network Extension run inside the macOS App Sandbox. The
host is allowed to initiate outbound connections for Hub delivery and signed
update checks; the extension is not given general outbound or inbound network
access. Both share only the dedicated EgressView App Group storage. No
filesystem exception grants access to your home directory or AWS CLI files.

## Is this for you?

Stop here if any of these is a no. Nothing below will work around them.

| You need | Why |
|---|---|
| **macOS 13 or newer** | The System Extension used for network monitoring |
| **An EgressView Hub you administer, running 1.9.0 or newer** | Enrolment needs a Hub that can approve it. **Hub 1.8.0 and older cannot accept this agent at all** — they have no agent endpoint. **Threat information needs Hub 1.10.0 or newer**; without it the screen says so rather than showing "no threats" |
| **Physical access to that Hub's settings** | Registration is completed by an administrator approving your Mac, not by the Mac itself |

Roughly ten minutes, most of which is macOS asking you to approve things.

## Install

1. Download `egressview-agent-<version>.pkg` from the
   [releases page](https://github.com/yo1t/egressview/releases) and open it.
2. Follow the installer. It puts the agent in **Applications** and starts it for
   you. The agent lives in the menu bar and has no window of its own.
3. Choose **Network monitoring** from its menu. macOS will ask you to allow a
   System Extension; this opens System Settings, where you approve it once.
4. In the Hub's settings, under the L3/L4 data source, choose **Issue an
   enrolment code**. You get six characters.
5. Back in the agent menu, choose **Hub delivery...**, enter the Hub's address
   and the six characters, and request access.
6. Approve the request in the Hub. Your Mac appears once you do — **it does not
   appear before**, which is the point: a machine cannot add itself.

Sending is off until you complete step 5. The agent shows you the exact
destination and what will and will not be sent before anything leaves.

If the code is refused, it has probably expired — they last ten minutes. Issue
another one.

Once installed, the agent updates itself: it offers the new version and runs the
installer for you. The System Extension does not need approving again.

## What leaves your Mac, and when

Three things, and nothing else. Each is listed so you can check the claim rather
than trust it.

| | Goes to | Contains |
|---|---|---|
| **Observations** | Your Hub | Addresses, ports, process names. **Not hostnames** — the name your app asked for stays local |
| **Update checks** | The signed distribution host | The agent's version. Disclosed on first launch |
| **Threat indicators and locations** | Your Hub | **Nothing about your traffic.** The whole list comes down and the matching happens here |

**No destination you connected to is ever sent anywhere to be looked up.** That
is a design constraint, not a setting.

### Two things you can turn on, both off by default

Without a Hub the agent has no locations and no threat feeds, so it can offer to
fetch them itself. Both are off unless you switch them on, in Settings.

- **Location lookups** send destination IP addresses to `ip-api.com`. This is the
  one place the agent would send the addresses it is watching to someone else,
  which is why it is off.
- **Threat feed downloads** fetch public block lists from `abuse.ch` and
  `spamhaus.org`. These are plain downloads, not lookup services: **no address of
  yours is sent**. What they learn is that your Mac asked at all. You download
  from them directly, so their terms are linked next to the setting — you are
  the one agreeing to them.

**With a Hub, the standalone setting is not offered.** The Hub already supplies
both, and having two paths running would quietly make "nothing leaves this Mac"
untrue.

**The agent never switches to public feeds on its own.** A Hub that goes down
for an hour must not change what your Mac sends while you are not looking. The
rule that picks the source is given whether you are enrolled and whether you
opted in, and **is not given whether the Hub answered** — measured, not
asserted: the Hub was stopped for three and a half minutes with the agent
restarted, forcing a fetch that failed, and it contacted no feed operator.

### If your Hub stays down, you can allow a fallback — and only you can

Threat information that is weeks old is not much use, so there is a way out of a
long Hub outage. It is off unless you turn it on, and it is deliberately hard to
trigger by accident:

- **The Hub is always tried first**, every time.
- Automatic fallback runs only when the stored indicators are **at least 24
  hours old**. A brief outage uses what is already on your Mac and contacts
  nobody.
- There is also a **"fetch once from public feeds"** button, for when you want
  it now and nothing else.
- The settings screen names **the source currently in use** — Hub, saved cache,
  or public feeds — so you can always see which one you are on.

As with the standalone setting: no destination of yours is sent, and what the
feed operators learn is that your Mac connected.

### If a feed cannot be read, the screen says which

Turning threat feeds on and seeing a number is not the same as being protected.
Four lists are fetched, and if any of them cannot be read — the site is down, or
its format changed — the settings screen names them:

> 22,329 indicators, but threatfox, urlhaus could not be read. Destinations are
> checked against the rest.

This exists because the opposite happened. Until August 2026 three of the four
feeds silently produced nothing, and the screen showed a total as though all was
well: destinations were being checked against a quarter of the list, and the
agent said it had checked. A quiet feed and a broken one must not look alike.

Feodo Tracker is excluded from that warning. It has published an empty list
since March 2026, which is a fact about the world rather than a fault, and a
warning that never clears is one nobody reads.

## Reading the screen

- **Network status** — the globe, the flow diagram, the timeline, and how much of
  the period was actually monitored.
- **Threats** — destinations that appear on a feed, and which application reached
  them. When nothing has been checked it says so; **an empty list is never shown
  as "nothing found"** unless something was actually looked at.
- **Connection log** — every connection in the period, sortable and filterable by
  column, exportable as CSV.

**Connections already open when monitoring starts are never seen**, and periods
the Mac slept through are marked as sleep rather than counted as gaps. The
screen says what it does not know.

The globe also keeps a record of which countries this Mac has reached, so a
first-time destination is visible as one.

### The globe's frame rate is yours to choose

3, 5 or 15 frames a second, starting at 5. Six degrees a second does not need
fifteen frames to read as motion, and the difference is battery. It stops
entirely when the window is closed or another tab is showing — a globe nobody
can see does not need to turn.

## Being told when something is wrong

The agent can notify you, and each kind is a separate switch: a destination on a
threat feed, monitoring stopping, delivery to the Hub failing, the threat
information changing, and recovery. There is a **test notification**, so you can
check the path works without waiting for something to break.

Two things keep notifications from becoming noise you learn to ignore:

- **An hour's cooldown per event**, so nothing repeats itself at you.
- **A daily budget** — five, twelve, twenty-five, or unlimited — defaulting to
  twelve.

**Monitoring alerts are exempt from that budget.** "Nothing is being recorded"
is the one message this agent exists to send, and it must not be crowded out by
a busy day of threat notifications. The hourly cooldown still applies to it.

## Uninstall

Do not move the app to Trash first. Open **Settings > Uninstall** in EgressView
Agent and review the removal summary. The guided flow:

1. stops Hub delivery and asks the enrolled Hub to revoke this Mac;
2. removes the network filter configuration and System Extension;
3. disables launch at login and deletes the Hub credential and pending queue;
4. optionally deletes local connection history; and
5. shows the app in Finder so you can quit it and move it to Trash.

Local history is kept unless you explicitly select its deletion. Observations
already accepted by a Hub are not deleted from that Hub. If the Hub cannot be
reached, the agent keeps its credential so you can retry. You may continue the
local removal only after acknowledging that the registration must then be
revoked manually in the Hub's Agent settings. macOS may require approval or a
restart to finish removing the System Extension.

## Building from source

The sections below are for working on the agent itself. **You do not need them
to use it.**

## Development

```sh
cd apps/agent-macos
swift test
swift run egressview-agent-spike --summary
```

Activating the network monitoring path requires a Developer ID certificate,
Network Extension entitlement, an Xcode app/System Extension host, and explicit
macOS user approval. Do not bypass System Integrity Protection or other macOS
security controls for development.

## Host app

Open `EgressViewAgent.xcodeproj` in Xcode. The shared `EgressView Agent` scheme
builds a menu-bar host app and embeds
`com.egressview.agent.filter.systemextension` under
`Contents/Library/SystemExtensions`.

The app starts paused. In an official sandboxed build, the user-facing choices
are Network monitoring and Pause. Network monitoring activates the System
Extension. The libproc-based lightweight collector remains available only to
non-sandboxed development builds and is not offered in release UI. A rejected
or incomplete approval never silently falls back to another collector.

The **Launch at login** menu option is off by default and is independent of the
selected monitoring mode. Enabling it registers the signed main app with
macOS only after an explicit click. If macOS requires renewed consent, the menu
shows **Approval required** and opens **System Settings > General > Login
Items** instead of repeatedly attempting registration. Registration errors are
shown in the menu and do not change or stop monitoring.

Choose **Open connection activity...** from the menu bar to view the latest
locally stored observations. The System Extension keeps observations in a
bounded memory queue. The signed host retrieves them over a named XPC endpoint,
whose listener rejects clients that do not have the expected bundle identifier
and signing team, and writes them to the user's App Group JSON Lines journal.
The journal uses `0700` directory and `0600` file permissions, rotates at 10
MiB, keeps one archive, tolerates an isolated malformed line, and displays at
most 500 deduplicated recent connections. It stores only connection metadata;
payloads are never collected.

Choose **Hub delivery...** to enroll this Mac with a Hub. Delivery is opt-in and
off by default. The confirmation screen shows the exact destination and the
metadata that will and will not be sent before enrollment or delivery can be
enabled. The Mac always initiates the connection; the Hub never polls the Mac.

Pending observations are stored locally with private permissions in bounded,
idempotent batches. A lost acknowledgement or restart resends the same batch
identifier. When the Mac is away from the Hub network, it waits for macOS to
report restored connectivity and uses full-jitter exponential backoff capped at
15 minutes rather than polling aggressively. **Send now** provides a manual
retry. The window displays pending/dropped counts, the oldest pending time, and
the last acknowledged time. Transport uses HTTPS with normal platform trust
validation; plaintext HTTP is accepted only on loopback for development.

The v1 Hub endpoint intentionally rejects compressed request bodies. The Agent
therefore sends at most 200 observations per request and spaces batches to stay
within the Hub rate limit. Compression requires an explicit protocol capability
and is deferred rather than being enabled unilaterally.

The activity window reports local record count, time range, and storage usage.
History remains under the existing storage limit by default. Users can opt into
a 1, 7, 30, or 90 day retention period; selecting a finite period requires
confirmation before older records are removed. **Delete History...** also
requires confirmation, deletes only the local journal, and does not stop
monitoring.

Unsigned Debug builds cannot access the production App Group container, so the
host uses its Application Support directory for local UI development. Release
builds fail closed when App Group access is unavailable; they do not silently
switch to a different storage location.

An unsigned compile can verify the project structure:

```sh
xcodebuild \
  -project EgressViewAgent.xcodeproj \
  -scheme 'EgressView Agent' \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES build
```

Unsigned builds cannot activate the System Extension. Before real activation,
configure a Developer ID team and obtain Apple's Network Extension entitlement
for both bundle identifiers documented in the Xcode project.

The project keeps development and direct-distribution entitlements separate.
Debug builds use Apple's standard `content-filter-provider` value with an Apple
Development profile. Release builds use the `-systemextension` value required
for Developer ID distribution. Supply your own team at build or archive time;
the project does not embed a maintainer-specific Team ID.

Release archives use manual signing so the host and embedded System Extension
can select their respective Developer ID profiles without storing maintainer
credentials in the project. Both Release targets enable Hardened Runtime as
required for Developer ID notarization. Build and verify the final bundle with:

```sh
EGRESSVIEW_DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
EGRESSVIEW_HOST_PROFILE="$HOST_PROFILE_NAME" \
EGRESSVIEW_FILTER_PROFILE="$FILTER_PROFILE_NAME" \
./scripts/build-release.sh
```

Set `EGRESSVIEW_NOTARY_PROFILE` to a credential profile previously stored with
`xcrun notarytool store-credentials` to submit, staple, and Gatekeeper-check the
same package. Without it, the script creates a signed ZIP ready for submission.
It refuses to overwrite an existing `dist/EgressViewAgent.zip`.

Then package the installer people actually download:

```sh
EGRESSVIEW_NOTARY_PROFILE="$NOTARY_PROFILE_NAME" \
EGRESSVIEW_INSTALLER_IDENTITY="$INSTALLER_IDENTITY" ./scripts/build-agent-pkg.sh
```

It reads the version from the built app and writes
`dist/egressview-agent-<version>.pkg`, notarised and stapled in its own right —
stapling the app alone is not enough, because a first install from an unstapled
package asks Apple over the network, and a new user's first impression should
not depend on their connection. Without a notary profile or an installer
identity it still builds a package, prints that it must not be published, and
means it.

A package, not a disk image, because a disk image cannot work here: macOS marks
everything a sandboxed application writes and refuses to launch an app taken
from it, so an agent that hands its user a disk image is handing over something
that cannot be opened. `installd` performs a package install, and nothing the
agent wrote is involved. `build-agent-dmg.sh` remains for reference only.

The two profile names are local Apple Developer resources. Do not commit Team
IDs, downloaded profiles, certificates, private keys, or notarization secrets.
