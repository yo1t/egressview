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
