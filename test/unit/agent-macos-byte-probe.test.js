'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('P3-183 reads probe counts before removing the closing flow', () => {
  const extension = fs.readFileSync(path.join(root,
    'apps/agent-macos/Xcode/SystemExtension/EgressViewFilterDataProvider.swift'), 'utf8');
  const close = extension.slice(extension.indexOf('override func handle(_ report: NEFilterReport)'),
    extension.indexOf('\n#endif', extension.indexOf('override func handle(_ report: NEFilterReport)')));
  assert.ok(close.indexOf('super.handle(report)') >= 0);
  assert.ok(close.indexOf('super.handle(report)') < close.indexOf('probeFlows.removeValue'));

  const base = fs.readFileSync(path.join(root,
    'apps/agent-macos/Sources/EgressViewNetworkExtension/PassOnlyFilterDataProvider.swift'), 'utf8');
  const reporting = base.slice(base.indexOf('open override func handle(_ report: NEFilterReport)'),
    base.indexOf('private func emit(_ observation: ConnectionObservation)'));
  assert.ok(reporting.indexOf('measuredByteCounts(for: socketFlow.identifier)') >= 0);
  assert.ok(reporting.indexOf('measuredByteCounts(for: socketFlow.identifier)') < reporting.indexOf('openFlows.complete('));
});

test('P3-183 UDP statistics spike never promotes report or callback bytes to measured traffic', () => {
  const extension = fs.readFileSync(path.join(root,
    'apps/agent-macos/Xcode/SystemExtension/EgressViewFilterDataProvider.swift'), 'utf8');
  const measured = extension.slice(extension.indexOf('override func measuredByteCounts('),
    extension.indexOf('override func handle(_ report: NEFilterReport)'));
  assert.match(measured, /state\.networkProtocol == \.tcp/);
  assert.match(extension, /probeProtocol == \.tcp && !firstProbeCallback/);
  assert.match(extension, /metadata\.networkProtocol == \.udp/);
  assert.match(extension, /normalVerdict\.statisticsReportFrequency = \.high/);
  assert.match(extension, /udpStatisticsFlows\.insert\(socketFlow\.identifier\)/);
  assert.match(extension, /udpStatisticsFlows\.remove\(flow\.identifier\)/);
});
