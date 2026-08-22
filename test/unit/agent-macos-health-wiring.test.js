'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const controller = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/AgentMonitoringController.swift'),
  'utf8'
);
const probe = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/SystemExtensionHealthProbe.swift'),
  'utf8'
);
const collector = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/FullMonitoringCollector.swift'),
  'utf8'
);
const mainWindow = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/ObservationWindowController.swift'),
  'utf8'
);
const diagnostics = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/AgentDiagnostics.swift'),
  'utf8'
);

describe('macOS Agent monitoring health wiring', () => {
  it('does not diagnose silence while monitoring is paused', () => {
    assert.match(controller, /private func checkHealth\(\) \{\s*guard gateState\.monitoringExpected else \{ return \}/);
    assert.match(controller, /guard self\.gateState\.monitoringExpected else \{ return \}/);
  });

  it('does not poll extension properties while observations prove health', () => {
    const recentGuard = controller.indexOf('MonitoringHealthCheck.hasRecentObservation(lastObservationAt)');
    const probeCall = controller.indexOf('healthProbe.check(', recentGuard);
    assert.ok(recentGuard >= 0);
    assert.ok(probeCall > recentGuard);
    assert.match(controller.slice(recentGuard, probeCall), /hasProbedCurrentSilence = false/);
    assert.match(controller.slice(recentGuard, probeCall), /return/);
  });

  it('submits at most one properties request per continuous silence period', () => {
    assert.match(controller, /guard !gateState\.hasProbedCurrentSilence else \{/);
    assert.match(controller, /gateState\.hasProbedCurrentSilence = true\s*healthProbe\.check/);
    assert.match(controller, /didWakeNotification[\s\S]*?hasProbedCurrentSilence = false/);
  });

  it('falls back to observation silence when macOS does not answer', () => {
    const unanswered = controller.slice(
      controller.indexOf('case .unanswered:'),
      controller.indexOf('case .healthy:')
    );
    const fallback = controller.slice(
      controller.indexOf('private func reportUnexplainedSilenceIfNeeded'),
      controller.indexOf('private func reportStall')
    );
    assert.match(unanswered, /reportUnexplainedSilenceIfNeeded/);
    assert.match(fallback, /evaluateSilenceWithoutExtensionState/);
    assert.match(fallback, /reportStall/);
  });

  it('clears a stall when real observations resume', () => {
    assert.match(controller, /recoveryHandler:[\s\S]*?gateState\.stall = nil/);
    assert.match(controller, /recoveryHandler:[\s\S]*?statusHandler\(\.fullActive\)/);
  });

  it('consumes a forced outage once and returns to real health automatically', () => {
    assert.match(diagnostics, /static func consumeForceNotRecording\(\) -> Bool/);
    assert.match(diagnostics, /removeObject\(forKey: forceNotRecordingKey\)/);
    assert.match(controller, /AgentDiagnostics\.consumeForceNotRecording\(\)/);
    assert.match(controller, /diagnosticRehearsalActive = true/);
    assert.match(controller, /finishDiagnosticRehearsalAfterDisplay\(generation:/);
    assert.match(controller, /MonitoringHealthCheck\.hasRecentObservation\(latestObservationAt\)/);
    assert.doesNotMatch(controller, /AgentDiagnostics\.forcesNotRecording/);
  });

  it('shows the first-connection wait only before monitoring has ever produced data', () => {
    assert.match(controller, /fullStarting\(waitingForFirstConnection: Bool\)/);
    assert.match(collector, /waitingForFirstConnection: try store\.monitoringStartedAt\(\) == nil/);
    assert.match(controller, /waitingForFirstConnection[\s\S]*Waiting for the first connection/);
  });

  it('shows the durable monitoring start beside storage without the coverage paragraph', () => {
    assert.match(mainWindow, /storage\.monitoringStartedAt/);
    assert.match(mainWindow, /Monitoring started: %@/);
    assert.doesNotMatch(mainWindow, /AgentCoverageNote\(coverage:/);
  });

  it('ignores callbacks from an older properties request', () => {
    assert.ok((probe.match(/guard self\.request === request else \{ return \}/g) || []).length >= 5);
    assert.match(probe, /finish\(\.unanswered, for: request\)/);
  });
});
