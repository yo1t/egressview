# EgressView Agent for Windows

[日本語版の導入ガイド](README.md)

## Install and get started

1. Download the Windows MSI for your PC (x64 or ARM64) from the [official download page](https://dl.egressview.com/). Windows 10 or later is required; no separate .NET runtime installation is needed.
2. Compare the SHA-256 for that package in `/windows/manifest.json` on the download page with the MSI you downloaded. In PowerShell, run `Get-FileHash -Algorithm SHA256 "<path to downloaded MSI>"`. The currently distributed MSI is not Authenticode-signed, so SmartScreen may report an unknown publisher. Do not run it if the checksums differ.
3. Run the MSI and approve the Windows administrator prompt. Open EgressView Agent from the Start menu and check its monitoring state on Network status. A Windows service records connections even when the window is closed.
4. Only if you use a Hub, enrol the Agent from its settings. Observation delivery remains off until you enable it separately.

The Agent keeps local records without a Hub. It can notify you of an update, but you download and install the newer MSI yourself. See [Windows Agent privacy](../../docs/agent-privacy-windows.md) for the destinations and data involved.

## What Hub delivery and update checks send

Enrollment sends the PC name, Windows version and Agent version to the chosen Hub. Enrollment alone does not enable observation delivery; you must explicitly switch it on in the app. When enabled, the Agent authenticates to that Hub with a Bearer token and sends the following JSON metadata. It neither collects nor sends packet contents.

- Batch: `schemaVersion`, `batchId`, `sentAt`, `agent`, `observations`.
- Agent: `hostName`, `platform`, `osVersion`, `agentVersion`.
- Each observation: `observationId`, `networkProtocol`, `localAddress`, `localPort`, `remoteAddress`, `remotePort`, `processID`, `processName`, `bundleID`, `firstObservedAt`, `lastObservedAt`, `bytesIn`, `bytesOut`, `collector`, `confidence`. Unavailable values are null.
- `remoteHostname` (destination hostname) is added only when the Hub advertises support in its capabilities response. It is not sent to older Hubs.

Update checks are separate from observation delivery. The Agent fetches `/windows/manifest.json` and its signature from `dl.egressview.com`. Its HTTP User-Agent contains the Agent and Windows versions. As with ordinary HTTP requests, the destination server can see the source IP address. Update checks send no observations or Hub credentials.

Developer build and service details are in the [Japanese README](README.md#開発者向け実装ビルド情報).
