'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const notifier = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/AgentUserNotifier.swift'),
  'utf8'
);
const settings = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/HubDeliveryController.swift'),
  'utf8'
);
const policy = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Sources/EgressViewAgentCore/AgentNotificationPolicy.swift'),
  'utf8'
);
// Split across files in P3-40; this checks the window's code, not one file.
const mainWindow = [
  'ObservationWindowController.swift', 'AgentMainViewModel.swift',
].map((name) => fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host', name), 'utf8'
)).join('\n');

describe('macOS Agent notifications', () => {
  it('offers all notification categories in a dedicated settings screen', () => {
    assert.match(settings, /case notifications/);
    assert.match(settings, /case \.notifications: notificationSettings/);
    for (const key of [
      'threatDetectionsEnabled',
      'monitoringEnabled',
      'hubDeliveryEnabled',
      'threatIntelChangesEnabled',
      'recoveryEnabled',
    ]) assert.match(settings, new RegExp(key));
  });

  it('shows local notification history in a dedicated main-window tab', () => {
    assert.match(mainWindow, /case notifications/);
    assert.match(mainWindow, /case \.notifications: return L\("Notification history"\)/);
    assert.match(mainWindow, /case \.notifications: notificationHistoryView/);
    assert.match(mainWindow, /ForEach\(notifications\.history\)/);
    assert.match(mainWindow, /Sent to macOS/);
    assert.match(mainWindow, /L\("Notifications today"\)/);
  });

  it('records an explicit reason in notification messages', () => {
    assert.match(notifier, /func notificationExplanation\(reason:/);
    assert.match(notifier, /L\("Why: %@\\n%@"/);
    assert.match(notifier, /Network monitoring has not started because macOS approval/);
    assert.match(notifier, /Delivery to the configured Hub failed/);
    assert.match(notifier, /latest scan found %lld previously unnotified destinations/);
  });

  it('does not run connection-history queries for the notification tab', () => {
    assert.match(
      mainWindow,
      /if selectedTab == \.notifications \{[\s\S]{0,180}selectionChanged\(shouldRefresh: false\)[\s\S]{0,80}return[\s\S]{0,80}guard let store/
    );
  });

  it('uses selectable daily limits and exposes suppressed counts', () => {
    assert.match(policy, /case five = 5/);
    assert.match(policy, /case twelve = 12/);
    assert.match(policy, /case twentyFive = 25/);
    assert.match(policy, /case unlimited = 0/);
    assert.match(settings, /suppressedToday/);
    assert.match(notifier, /countsTowardDailyLimit: kind != \.monitoring/);
    assert.match(policy, /dailyLimitCountToday/);
  });

  it('does not notify historical threats or duplicate Hub notifications', () => {
    assert.match(notifier, /lastThreatScanAt = Date\(\)/);
    assert.match(notifier, /guard hub\.notificationState != \.healthy/);
    assert.match(notifier, /lastObservedAt >= since/);
  });

  it('keeps lock-screen threat notifications aggregate-only', () => {
    const scan = notifier.slice(notifier.indexOf('private func handleThreatReport'));
    assert.match(scan, /previously unnotified destinations that matched threat information/);
    assert.doesNotMatch(scan, /candidate\.address[^\n]*body:/);
    assert.doesNotMatch(scan, /candidate\.hostname[^\n]*body:/);
  });

  it('uses macOS notifications without adding a remote notification credential', () => {
    assert.match(notifier, /UNUserNotificationCenter/);
    assert.doesNotMatch(notifier, /Slack|webhook|SMTP|email/i);
  });
});
