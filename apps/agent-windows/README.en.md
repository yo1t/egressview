# EgressView Agent for Windows

[日本語版](README.md)

## What Hub delivery and update checks send

Enrollment sends the PC name, Windows version and Agent version to the chosen Hub. Enrollment alone does not enable observation delivery; you must explicitly switch it on in the app. When enabled, the Agent authenticates to that Hub with a Bearer token and sends the following JSON metadata. It neither collects nor sends packet contents.

- Batch: `schemaVersion`, `batchId`, `sentAt`, `agent`, `observations`.
- Agent: `hostName`, `platform`, `osVersion`, `agentVersion`.
- Each observation: `observationId`, `networkProtocol`, `localAddress`, `localPort`, `remoteAddress`, `remotePort`, `processID`, `processName`, `bundleID`, `firstObservedAt`, `lastObservedAt`, `bytesIn`, `bytesOut`, `collector`, `confidence`. Unavailable values are null.
- `remoteHostname` (destination hostname) is added only when the Hub advertises support in its capabilities response. It is not sent to older Hubs.

Update checks are separate from observation delivery. The Agent fetches `/windows/manifest.json` and its signature from `dl.egressview.com`. Its HTTP User-Agent contains the Agent and Windows versions. As with ordinary HTTP requests, the destination server can see the source IP address. Update checks send no observations or Hub credentials.

The [Japanese guide](README.md) covers building, installing and operating the current Windows Agent.
