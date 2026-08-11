# EgressView macOS Agent Spike

This package validates the two macOS collection paths without changing the
existing EgressView server runtime.

- `EgressViewAgentCore`: shared observation model, deduplication, libproc
  collector, and explicit monitoring-mode state machine.
- `EgressViewNetworkExtension`: pass-only Network Extension provider skeleton.
- `egressview-agent-spike`: one-shot local socket inventory for development.

The lightweight collector reads socket metadata only. It does not read payloads,
decrypt traffic, or modify network behavior. Byte counts are intentionally
reported as unavailable rather than zero.

## Development

```sh
cd apps/agent-macos
swift test
swift run egressview-agent-spike --summary
```

Activating the full monitoring path requires a Developer ID certificate,
Network Extension entitlement, an Xcode app/System Extension host, and explicit
macOS user approval. Do not bypass System Integrity Protection or other macOS
security controls for development.

## Host app

Open `EgressViewAgent.xcodeproj` in Xcode. The shared `EgressView Agent` scheme
builds a menu-bar host app and embeds
`com.egressview.agent.filter.systemextension` under
`Contents/Library/SystemExtensions`.

The app starts paused. Choosing Lightweight monitoring first disables the
Content Filter and waits for that operation to finish before polling sockets.
Choosing Full monitoring stops lightweight polling before requesting System
Extension activation. A rejected or incomplete approval never silently falls
back to lightweight monitoring.

Choose **Open connection activity...** from the menu bar to view the latest
locally stored observations. The System Extension keeps observations in a
bounded memory queue. The signed host retrieves them over a named XPC endpoint,
whose listener rejects clients that do not have the expected bundle identifier
and signing team, and writes them to the user's App Group JSON Lines journal.
The journal uses `0700` directory and `0600` file permissions, rotates at 10
MiB, keeps one archive, tolerates an isolated malformed line, and displays at
most 500 deduplicated recent connections. It stores only connection metadata;
payloads are never collected. Hub delivery remains off and is not implemented
by this phase.

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

The two profile names are local Apple Developer resources. Do not commit Team
IDs, downloaded profiles, certificates, private keys, or notarization secrets.
