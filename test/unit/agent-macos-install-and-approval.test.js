'use strict';

// Two places a first install stopped on 2026-10-09: the installer's
// destination page ("can't be installed in this location", nothing selected),
// and the network extension's approval, which macOS 27 lists only under
// Extensions > By Category. These pin what fixed each.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agent = path.join(__dirname, '..', '..', 'apps', 'agent-macos');
const read = relative => fs.readFileSync(path.join(agent, relative), 'utf8');

test('インストーラーはインストール先を選ばせない（起動ディスクのみ）', () => {
  const script = read('scripts/build-agent-pkg.sh');
  const distribution = script.slice(script.indexOf('<installer-gui-script'), script.indexOf('</installer-gui-script>'));
  assert.match(distribution, /rootVolumeOnly="true"/, 'the destination page is skipped');
  assert.doesNotMatch(distribution, /<domains\b/, '<domains> brings the destination page back');
});

test('承認待ちになると、許可の手順の画面とメニュー項目を出す', () => {
  const delegate = read('Xcode/Host/AgentAppDelegate.swift');
  assert.match(delegate, /approvalGuide\.update\(for: status\)/, 'every status reaches the guide');
  assert.match(delegate, /How to allow network monitoring\.\.\./, 'the menu offers the guide while waiting');
  const guide = read('Xcode/Host/ExtensionApprovalGuideWindow.swift');
  assert.match(guide, /case \.approvalRequired:/);
  assert.match(guide, /ExtensionApprovalGuide\.settingsURL/, 'the button opens the pane that holds the approval');
});

test('許可の手順の画面がアプリのビルドに含まれている', () => {
  const project = read('EgressViewAgent.xcodeproj/project.pbxproj');
  assert.match(project, /ExtensionApprovalGuideWindow\.swift in Sources \*\/ = \{isa = PBXBuildFile/);
  const sources = project.slice(project.indexOf('/* Host Sources */ = {isa = PBXSourcesBuildPhase'));
  assert.match(sources.slice(0, sources.indexOf('};')), /ExtensionApprovalGuideWindow\.swift in Sources/);
});

test('手順の文言は英語と日本語の両方にある', () => {
  const core = read('Sources/EgressViewAgentCore/ExtensionApprovalGuide.swift');
  const keys = [...core.matchAll(/^\s+"([^"]+)",$/gm)].map(match => match[1]);
  assert.ok(keys.length >= 7, `steps found: ${keys.length}`);
  for (const language of ['en', 'ja']) {
    const strings = read(`Xcode/Host/${language}.lproj/Localizable.strings`);
    for (const key of keys) assert.ok(strings.includes(`"${key}" =`), `${language}: ${key}`);
  }
});
