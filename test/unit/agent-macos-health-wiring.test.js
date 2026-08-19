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

describe('macOS Agent monitoring health wiring', () => {
  it('does not diagnose silence while monitoring is paused', () => {
    assert.match(controller, /private func checkHealth\(\) \{\s*guard gateState\.monitoringExpected else \{ return \}/);
    assert.match(controller, /guard self\.gateState\.monitoringExpected else \{ return \}/);
  });

  it('falls back to observation silence when macOS does not answer', () => {
    const unanswered = controller.slice(
      controller.indexOf('case .unanswered:'),
      controller.indexOf('case .healthy:')
    );
    assert.match(unanswered, /evaluateSilenceWithoutExtensionState/);
    assert.match(unanswered, /reportStall/);
  });

  it('clears a stall when real observations resume', () => {
    assert.match(controller, /recoveryHandler:[\s\S]*?gateState\.stall = nil/);
    assert.match(controller, /recoveryHandler:[\s\S]*?statusHandler\(\.fullActive\)/);
  });

  it('ignores callbacks from an older properties request', () => {
    assert.ok((probe.match(/guard self\.request === request else \{ return \}/g) || []).length >= 5);
    assert.match(probe, /finish\(\.unanswered, for: request\)/);
  });
});
