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

    assert.match(hostVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(extensionVersion, hostVersion);
    assert.equal(extensionBuild, hostBuild);
  });

  it('versions the Mach service with the Extension build', () => {
    const build = entitlement(extensionInfo, 'CFBundleVersion');
    const service = entitlement(extensionInfo, 'NEMachServiceName');
    const xpcSource = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Sources/EgressViewAgentCore/FullMonitoringXPC.swift'),
      'utf8'
    );

    assert.equal(service, `group.com.egressview.agent.xpc.${build}`);
    assert.match(xpcSource, new RegExp(`machServiceName = "${service.replaceAll('.', '\\.')}"`));
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
    assert.match(appDelegate, /url\(forResource: "ThirdPartyNotices", withExtension: "txt"\)/);
    assert.ok((appDelegate.match(/L\("About EgressView Agent"\)/g) || []).length >= 2);
    assert.match(english, /"About EgressView Agent" = "About EgressView Agent";/);
    assert.match(japanese, /"About EgressView Agent" = "EgressView Agentについて";/);

    const project = fs.readFileSync(
      path.join(root, 'apps/agent-macos/EgressViewAgent.xcodeproj/project.pbxproj'),
      'utf8'
    );
    const notices = fs.readFileSync(
      path.join(root, 'apps/agent-macos/Xcode/Host/ThirdPartyNotices.txt'),
      'utf8'
    );
    assert.match(project, /ThirdPartyNotices\.txt in Resources/);
    assert.match(notices, /Natural Earth/);
  });
});

describe('実機確認で利用者向けバージョンを消費しない (P3-32)', () => {
  const script = fs.readFileSync(
    path.join(root, 'apps/agent-macos/scripts/build-agent-pkg.sh'), 'utf8'
  );

  it('同じ短縮バージョンの再ビルドは、止めずに前のファイルを退避する', () => {
    // It used to fail and ask for the file to be deleted. Both branches of
    // that message ended in "delete it", while bumping the short version
    // changed the file name and skipped the deletion -- so the cheap path was
    // the one that spent a user-facing version, taken four times on
    // 2026-08-29 by someone who had just read the comment explaining not to.
    assert.match(script, /mv "\$PKG_PATH" "\$ARCHIVED"/);
    assert.doesNotMatch(script, /already exists\. Remove it/);
  });

  it('未署名ビルドは公開できる名前を取らない', () => {
    // Running it without an installer identity moved the signed, notarised,
    // already-published 0.5.48 aside and put an unsigned package in its place.
    assert.match(script, /egressview-agent-\$VERSION-unsigned\.pkg/);
    const naming = script.indexOf('if [[ -n "$INSTALLER_IDENTITY" ]]');
    const archiving = script.indexOf('if [[ -e "$PKG_PATH" ]]');
    assert.ok(naming !== -1 && naming < archiving,
      'the name must be chosen before anything is moved aside');
  });

  it('ビルドの最後に、次の一手を述べる', () => {
    assert.match(script, /raise CFBundleVersion only/);
  });

  it('README がこの規則を書いている', () => {
    const readme = fs.readFileSync(path.join(root, 'apps/agent-macos/README.md'), 'utf8');
    assert.match(readme, /does not look at `CFBundleShortVersionString`/);
  });
});

