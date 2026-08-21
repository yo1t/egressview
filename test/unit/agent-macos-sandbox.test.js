'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const entitlementFiles = {
  hostDebug: 'apps/agent-macos/Xcode/Host/EgressViewAgent.entitlements',
  hostRelease: 'apps/agent-macos/Xcode/Host/EgressViewAgent.DeveloperID.entitlements',
  extensionDebug: 'apps/agent-macos/Xcode/SystemExtension/EgressViewFilter.entitlements',
  extensionRelease: 'apps/agent-macos/Xcode/SystemExtension/EgressViewFilter.DeveloperID.entitlements',
};
const hostInfo = 'apps/agent-macos/Xcode/Host/Info.plist';
const extensionInfo = 'apps/agent-macos/Xcode/SystemExtension/Info.plist';

function entitlement(file, key) {
  const plist = fs.readFileSync(path.join(root, file), 'utf8');
  const marker = `<key>${key}</key>`;
  const index = plist.indexOf(marker);
  if (index < 0) return null;
  const value = plist.slice(index + marker.length).match(/^\s*<(true|false)\s*\/>|^\s*<string>([^<]*)<\/string>/);
  return value ? (value[1] || value[2]) : null;
}

describe('macOS Agent App Sandbox boundary', () => {
  it('keeps host and System Extension release versions aligned', () => {
    const hostVersion = entitlement(hostInfo, 'CFBundleShortVersionString');
    const extensionVersion = entitlement(extensionInfo, 'CFBundleShortVersionString');
    const hostBuild = entitlement(hostInfo, 'CFBundleVersion');
    const extensionBuild = entitlement(extensionInfo, 'CFBundleVersion');

    assert.equal(hostVersion, '0.5.11');
    assert.equal(extensionVersion, hostVersion);
    assert.equal(extensionBuild, hostBuild);
  });

  it('sandboxes every shipped process in Debug and Developer ID builds', () => {
    for (const file of Object.values(entitlementFiles)) {
      assert.equal(entitlement(file, 'com.apple.security.app-sandbox'), 'true', file);
    }
  });

  it('allows outbound connections only from the host', () => {
    for (const file of [entitlementFiles.hostDebug, entitlementFiles.hostRelease]) {
      assert.equal(entitlement(file, 'com.apple.security.network.client'), 'true', file);
    }
    for (const file of [entitlementFiles.extensionDebug, entitlementFiles.extensionRelease]) {
      assert.equal(entitlement(file, 'com.apple.security.network.client'), null, file);
    }
    for (const file of Object.values(entitlementFiles)) {
      assert.equal(entitlement(file, 'com.apple.security.network.server'), null, file);
    }
  });

  it('does not escape the sandbox through filesystem exceptions', () => {
    const forbidden = [
      'com.apple.security.temporary-exception.files.absolute-path.read-only',
      'com.apple.security.temporary-exception.files.absolute-path.read-write',
      'com.apple.security.temporary-exception.files.home-relative-path.read-only',
      'com.apple.security.temporary-exception.files.home-relative-path.read-write',
    ];
    for (const file of Object.values(entitlementFiles)) {
      for (const key of forbidden) assert.equal(entitlement(file, key), null, `${file}: ${key}`);
    }
  });

  it('keeps the release script fail-closed if sandbox entitlements drift', () => {
    const script = fs.readFileSync(
      path.join(root, 'apps/agent-macos/scripts/build-release.sh'),
      'utf8'
    );
    assert.match(script, /Print :com\.apple\.security\.app-sandbox/);
    assert.match(script, /Print :com\.apple\.security\.network\.client/);
    assert.match(script, /Host contains forbidden sandbox entitlement/);
    assert.match(script, /Round-trip host contains forbidden sandbox entitlement/);
  });

  it('enables the Xcode sandbox capability for both targets and configurations', () => {
    const project = fs.readFileSync(
      path.join(root, 'apps/agent-macos/EgressViewAgent.xcodeproj/project.pbxproj'),
      'utf8'
    );
    assert.equal((project.match(/ENABLE_APP_SANDBOX = YES/g) || []).length, 4);
  });

  it('checks Lightweight availability before disabling network monitoring', () => {
    const controller = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/AgentMonitoringController.swift'),
      'utf8'
    );
    const method = controller.slice(
      controller.indexOf('func selectLightweightMonitoring()'),
      controller.indexOf('func restoreMonitoringState()')
    );

    assert.ok(method.indexOf('LibProcSocketSnapshotProvider') >= 0);
    assert.ok(method.indexOf('LibProcSocketSnapshotProvider') < method.indexOf('disableFilter'));
    assert.match(controller, /current monitoring mode was not changed/);
  });

  it('does not offer Lightweight monitoring in sandboxed release builds', () => {
    const identity = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Sources/EgressViewAgentCore/AgentPackageVerifier.swift'),
      'utf8'
    );
    const controller = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/AgentMonitoringController.swift'),
      'utf8'
    );
    const appDelegate = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/AgentAppDelegate.swift'),
      'utf8'
    );
    const settings = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/HubDeliveryController.swift'),
      'utf8'
    );

    assert.match(controller, /isLightweightMonitoringAvailable: Bool \{\s*\/\/[\s\S]*?false\s*\}/);
    assert.match(settings, /isLightweightMonitoringAvailable = false/);
    assert.match(settings, /Picker\(L\("Mode"\)[\s\S]*?\.id\(language\.language\.rawValue\)/);
    assert.doesNotMatch(identity, /SecTaskCopyValueForEntitlement/);
    assert.match(appDelegate, /if controller\.isLightweightMonitoringAvailable/);
    assert.match(settings, /availableMonitoringModes/);
    assert.doesNotMatch(settings, /development builds only/);
  });

  it('uses the standard macOS About panel so the installed version is visible', () => {
    const appDelegate = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/AgentAppDelegate.swift'),
      'utf8'
    );
    const english = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/en.lproj/Localizable.strings'),
      'utf8'
    );
    const japanese = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/ja.lproj/Localizable.strings'),
      'utf8'
    );

    assert.match(appDelegate, /orderFrontStandardAboutPanel/);
    assert.ok((appDelegate.match(/L\("About EgressView Agent"\)/g) || []).length >= 2);
    assert.match(english, /"About EgressView Agent" = "About EgressView Agent";/);
    assert.match(japanese, /"About EgressView Agent" = "EgressView Agentについて";/);
  });
});
