'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const mac = ['apps', 'agent-macos'];

describe('macOS short-flow capture diagnostics', () => {
  it('counts failures before registering a flow without storing identity', () => {
    const adapter = read(...mac, 'Sources', 'EgressViewNetworkExtension', 'NetworkFlowObservationMapper.swift');
    const provider = read(...mac, 'Sources', 'EgressViewNetworkExtension', 'PassOnlyFilterDataProvider.swift');
    const counters = read(...mac, 'Sources', 'EgressViewAgentCore', 'FlowCaptureDiagnostics.swift');
    assert.match(adapter, /case missingLocalEndpoint/);
    assert.match(provider, /didRecordFlowCapture\(\.missingLocalEndpoint\)/);
    assert.match(provider, /didRecordFlowCapture\(\.registeredFlow\)/);
    assert.match(provider, /didRecordFlowCapture\(observation == nil \? \.unregisteredCloseUnresolved : \.unregisteredCloseRecovered\)/);
    assert.match(counters, /var unregisteredClosesRecovered: UInt64/);
    assert.match(counters, /var unregisteredClosesUnresolved: UInt64/);
    assert.doesNotMatch(counters, /\b(?:var|let)\s+(?:remoteAddress|remoteHostname|processName|bundleID|payload)\b/);
  });

  it('wires the optional XPC snapshot through the collector to a manual settings refresh', () => {
    const xpc = read(...mac, 'Sources', 'EgressViewAgentCore', 'FullMonitoringXPC.swift');
    const server = read(...mac, 'Xcode', 'SystemExtension', 'FullMonitoringXPCServer.swift');
    const collector = read(...mac, 'Xcode', 'Host', 'FullMonitoringCollector.swift');
    const controller = read(...mac, 'Xcode', 'Host', 'AgentMonitoringController.swift');
    const app = read(...mac, 'Xcode', 'Host', 'AgentAppDelegate.swift');
    const settings = read(...mac, 'Xcode', 'Host', 'HubDeliveryController.swift');
    assert.match(xpc, /@objc optional func readFlowCaptureDiagnostics/);
    assert.match(server, /func readFlowCaptureDiagnostics\(withReply/);
    assert.match(collector, /proxy\.readFlowCaptureDiagnostics\?\(withReply: reply\)/);
    assert.match(collector, /persistenceDiagnostics\.recordPersisted/);
    assert.match(controller, /fullMonitoringCollector\?\.requestFlowCaptureDiagnostics\(\)/);
    assert.match(app, /onRefreshFlowDiagnostics:.*requestFlowCaptureDiagnostics/);
    assert.match(settings, /Button\(L\("Refresh capture counters"\)\)/);
    assert.match(settings, /model\.refreshFlowDiagnostics\(\)/);
  });

  it('does not let an earlier drain timeout invalidate a newer request', () => {
    const collector = read(...mac, 'Xcode', 'Host', 'FullMonitoringCollector.swift');
    assert.match(collector, /drainRequestGeneration\s*&\+=\s*1\s*\n\s*let generation = drainRequestGeneration/);
    assert.match(collector, /guard let self, self\.isDraining,\s*generation == self\.drainRequestGeneration else \{ return \}/);
    assert.match(collector, /guard let self, generation == self\.drainRequestGeneration else \{ return \}\s*self\.isDraining = false\s*self\.consume\(data\)/);
    assert.match(collector, /private func resetConnection\(\) \{\s*drainRequestGeneration\s*&\+=\s*1/);
  });
});
