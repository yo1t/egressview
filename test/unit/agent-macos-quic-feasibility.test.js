'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const provider = read(
  'apps', 'agent-macos', 'Sources', 'EgressViewNetworkExtension',
  'PassOnlyFilterDataProvider.swift'
);
const diagnostics = read(
  'apps', 'agent-macos', 'Sources', 'EgressViewAgentCore',
  'QUICFeasibilityDiagnostics.swift'
);
const collector = read(
  'apps', 'agent-macos', 'Xcode', 'Host', 'FullMonitoringCollector.swift'
);
const settings = read(
  'apps', 'agent-macos', 'Xcode', 'Host', 'HubDeliveryController.swift'
);
const xpc = read(
  'apps', 'agent-macos', 'Sources', 'EgressViewAgentCore', 'FullMonitoringXPC.swift'
);
const xpcServer = read(
  'apps', 'agent-macos', 'Xcode', 'SystemExtension', 'FullMonitoringXPCServer.swift'
);
const productionProvider = read(
  'apps', 'agent-macos', 'Xcode', 'SystemExtension', 'EgressViewFilterDataProvider.swift'
);

describe('macOS Agent QUIC feasibility probe', () => {
  it('runs only inside the existing destination-name opt-in path', () => {
    assert.match(provider, /decision == \.allowAndReadServerName/);
    assert.match(provider, /metadata\.networkProtocol == \.udp, metadata\.remotePort == 443/);
    assert.match(provider, /didObserveQUICFeasibility\(\.udp443Flow\)/);
  });

  it('emits aggregate-only events and never carries packet bytes or identity', () => {
    const event = provider.slice(
      provider.indexOf('public enum QUICFeasibilityEvent'),
      provider.indexOf('open class PassOnlyFilterDataProvider')
    );
    assert.match(event, /offset: Int/);
    assert.match(event, /byteCount: Int/);
    assert.match(event, /classification: QUICInitialCandidate/);
    assert.doesNotMatch(event, /Data|address|hostname|process|payload/i);
    assert.doesNotMatch(diagnostics, /remoteAddress|localAddress|processName|bundleID/);
  });

  it('recognises bounded QUIC v1 and v2 long-header candidates', () => {
    assert.match(diagnostics, /private static let version1: UInt32 = 0x0000_0001/);
    assert.match(diagnostics, /private static let version2: UInt32 = 0x6b33_43cf/);
    assert.match(diagnostics, /destinationConnectionIDLength <= 20/);
    assert.match(diagnostics, /sourceConnectionIDLength <= 20/);
  });

  it('reads counters only when the user explicitly refreshes the settings view', () => {
    assert.match(settings, /Button\(L\("Refresh QUIC check counters"\)\)/);
    assert.match(settings, /model\.refreshQUICDiagnostics\(\)/);
    assert.match(collector, /func requestQUICDiagnostics\(\)/);
    assert.match(collector, /private var diagnosticsConnection: NSXPCConnection\?/);
    assert.match(collector, /finishDiagnosticsRequest\(generation: generation\)/);
    assert.doesNotMatch(collector, /requestDiagnosticsIfDue/);
  });

  it('synchronizes the opt-in over authenticated XPC and defaults the extension to off', () => {
    assert.match(xpc, /@objc optional func setReadsServerName/);
    assert.match(xpcServer, /private var readsServerName = false/);
    assert.match(xpcServer, /func setReadsServerName\(_ enabled: Bool/);
    assert.match(productionProvider, /FullMonitoringXPCServer\.shared\.isServerNameReadingEnabled/);
    assert.match(collector, /syncServerNamePolicyIfNeeded\(proxy\)/);
    assert.match(collector, /needsServerNamePolicySync = true/);
    const liveUpdate = collector.slice(
      collector.indexOf('func setReadsServerName'),
      collector.indexOf('private func startOnQueue')
    );
    assert.match(liveUpdate, /remoteObjectProxyWithErrorHandler/);
    assert.match(liveUpdate, /syncServerNamePolicyIfNeeded\(proxy\)/);
    assert.doesNotMatch(liveUpdate, /resetConnection\(\)\s*$/m);
    assert.doesNotMatch(productionProvider, /ServerNamePreferences/);
  });
});
