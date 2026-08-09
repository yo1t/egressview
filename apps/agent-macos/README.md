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
builds a menu-bar host app and embeds `EgressViewFilter.systemextension` under
`Contents/Library/SystemExtensions`.

The app starts paused. Choosing Lightweight monitoring first disables the
Content Filter and waits for that operation to finish before polling sockets.
Choosing Full monitoring stops lightweight polling before requesting System
Extension activation. A rejected or incomplete approval never silently falls
back to lightweight monitoring.

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
