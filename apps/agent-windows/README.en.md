# EgressView Agent for Windows

[日本語版の導入ガイド](README.md)

## Install and get started

1. Download the Windows MSI for your PC (x64 or ARM64) from the [official download page](https://dl.egressview.com/). Windows 10 or later is required; no separate .NET runtime installation is needed.
2. Compare the SHA-256 for that package in `/windows/manifest.json` on the download page with the MSI you downloaded. In PowerShell, run `Get-FileHash -Algorithm SHA256 "<path to downloaded MSI>"`. The currently distributed MSI is not Authenticode-signed, so SmartScreen may report an unknown publisher. Do not run it if the checksums differ.
3. Run the MSI and approve the Windows administrator prompt. Open EgressView Agent from the Start menu and check its monitoring state on Network status. A Windows service records connections even when the window is closed.
4. Only if you use a Hub, enrol the Agent from its settings. Observation delivery remains off until you enable it separately.

The Agent keeps local records without a Hub. It can notify you of an update, but you download and install the newer MSI yourself. See [Windows Agent privacy](../../docs/agent-privacy-windows.md) for the destinations and data involved.

## PCs with Smart App Control on

**Until the builds are signed, the Agent's window (`EgressView.Agent.Ui.exe`) will not open on Windows 11 with Smart App Control on.** Windows reports that it blocked an app that may be unsafe. Unlike SmartScreen, there is no way to allow a single app.

To check whether it is on, run this in an administrator PowerShell:

```powershell
Get-MpComputerStatus | Select-Object SmartAppControlState
```

`On` means you are affected. `Evaluation` or `Off` means you are not.

**What we confirmed on a real PC (2026-11-21, one Windows 11 PC):** the window did not open, but the Windows service kept running and Hub delivery did not stop. The only blocked file recorded was the window's executable. We have not confirmed that the service is left running on other PCs.

You have two options:

- **Leave it on and skip the window:** recording and Hub delivery continue (confirmed on the PC above), and you can see the history in the Hub. Without a Hub there is no way to view the history on this PC.
- **Turn Smart App Control off:** Windows Security → App & browser control → Smart App Control settings → Off. This stops it blocking every unsigned app without a reputation, not just EgressView. **On some Windows builds, once it is off it cannot be turned back on without reinstalling or resetting the PC.** The decision is yours.

## What Hub delivery and update checks send

Enrollment sends the PC name, Windows version and Agent version to the chosen Hub. Enrollment alone does not enable observation delivery; you must explicitly switch it on in the app. When enabled, the Agent authenticates to that Hub with a Bearer token and sends the following JSON metadata. It neither collects nor sends packet contents.

- Batch: `schemaVersion`, `batchId`, `sentAt`, `agent`, `observations`.
- Agent: `hostName`, `platform`, `osVersion`, `agentVersion`. The PC's maker and model, `manufacturer` and `model`, are added only when the Hub advertises support in its capabilities response (the Hub shows them in its device list).
- Each observation: `observationId`, `networkProtocol`, `localAddress`, `localPort`, `remoteAddress`, `remotePort`, `processID`, `processName`, `bundleID`, `firstObservedAt`, `lastObservedAt`, `bytesIn`, `bytesOut`, `collector`, `confidence`. Unavailable values are null.
- `remoteHostname` (destination hostname) is added only when the Hub advertises support in its capabilities response. It is not sent to older Hubs.
- Connection attempts that failed (the destination did not answer or refused) are sent too, as observations with no bytes, for LAN scan detection.
- `inboundProbes`: per LAN sender and two-minute window, counts of attempts on this PC's closed ports (`windowStart`, `windowSeconds`, `localAddress`, `sourceAddress`, `networkProtocol`, `distinctPorts`, `packets`, `samplePorts`). Sent only when the Hub advertises support in its capabilities response. No contents.

Update checks are separate from observation delivery. The Agent fetches `/windows/manifest.json` and its signature from `dl.egressview.com`. Its HTTP User-Agent contains the Agent and Windows versions. As with ordinary HTTP requests, the destination server can see the source IP address. Update checks send no observations or Hub credentials.

Developer build and service details are in the [Japanese README](README.md#開発者向け実装ビルド情報).
