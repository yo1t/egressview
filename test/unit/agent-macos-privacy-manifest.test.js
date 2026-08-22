'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const agentRoot = path.join(root, 'apps', 'agent-macos');
const manifests = {
  host: 'apps/agent-macos/Xcode/Host/PrivacyInfo.xcprivacy',
  extension: 'apps/agent-macos/Xcode/SystemExtension/PrivacyInfo.xcprivacy',
};
const projectFile = 'apps/agent-macos/EgressViewAgent.xcodeproj/project.pbxproj';

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

// The manifest is a plist, and this repository has no plist parser. These
// readers cover the three shapes the file actually uses; anything else in it
// would be undeclared and should fail loudly rather than be skipped silently.
function boolValue(plist, key) {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`));
  return match ? match[1] === 'true' : null;
}

function isEmptyArray(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<array\\s*/>`).test(plist);
}

function accessedApiReasons(plist, category) {
  const at = plist.indexOf(`<string>${category}</string>`);
  if (at < 0) return null;
  const rest = plist.slice(at);
  const reasons = rest.match(/<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!reasons) return [];
  return [...reasons[1].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);
}

// Every Swift file the agent ships, so a new call site cannot appear in a
// directory the scan happens to miss.
function swiftSources() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.build' || entry.name === 'build') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.swift') && !full.includes(`${path.sep}Tests${path.sep}`)) {
        found.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(agentRoot, 'Sources'));
  walk(path.join(agentRoot, 'Xcode'));
  return found;
}

describe('macOS Agent privacy manifest', () => {
  it('ホストとSystem Extensionの両方に同梱する', () => {
    // A manifest on the app but not on the extension describes only half of
    // what runs on the user's machine.
    for (const [name, file] of Object.entries(manifests)) {
      assert.ok(fs.existsSync(path.join(root, file)), `${name} privacy manifest is missing`);
    }
  });

  it('ビルド成果物に入るようプロジェクトへ登録されている', () => {
    // A manifest that exists in the repository but is not a resource of either
    // target never reaches the bundle, and would be a claim with nothing
    // behind it.
    const project = read(projectFile);
    const resourcePhases = [...project.matchAll(/isa = PBXResourcesBuildPhase;[^\n]*/g)].map((m) => m[0]);
    const withManifest = resourcePhases
      .filter((phase) => phase.includes('PrivacyInfo.xcprivacy'));
    assert.equal(
      withManifest.length, 2,
      'both the host and the extension must carry the manifest as a build resource'
    );
  });

  it('トラッキングしないと宣言する', () => {
    for (const [name, file] of Object.entries(manifests)) {
      const plist = read(file);
      assert.equal(boolValue(plist, 'NSPrivacyTracking'), false, `${name} declares tracking`);
      assert.ok(isEmptyArray(plist, 'NSPrivacyTrackingDomains'), `${name} lists a tracking domain`);
    }
  });

  it('収集するデータ種別を持たない', () => {
    // The product's central claim is that observations stay on the user's own
    // hardware. If this list ever stops being empty, the claim has changed and
    // the documentation has to change with it.
    for (const [name, file] of Object.entries(manifests)) {
      assert.ok(
        isEmptyArray(read(file), 'NSPrivacyCollectedDataTypes'),
        `${name} declares collected data; docs/agent-privacy.md must be revisited`
      );
    }
  });

  it('UserDefaultsの利用に理由を宣言している', () => {
    const sources = swiftSources();
    const usesStandard = sources.some((s) => s.includes('UserDefaults.standard'));
    const usesSuite = sources.some((s) => s.includes('UserDefaults(suiteName'));
    for (const [name, file] of Object.entries(manifests)) {
      const reasons = accessedApiReasons(read(file), 'NSPrivacyAccessedAPICategoryUserDefaults');
      assert.ok(reasons, `${name} does not declare the user defaults category`);
      if (usesStandard) assert.ok(reasons.includes('CA92.1'), `${name} is missing reason CA92.1`);
      if (usesSuite) assert.ok(reasons.includes('1C8F.1'), `${name} is missing reason 1C8F.1`);
    }
  });

  it('ファイルメタデータの読み取りに理由を宣言している', () => {
    // attributesOfItem is in Apple's file-timestamp category even when only
    // the size is read, which is the only thing this app reads.
    const sources = swiftSources();
    assert.ok(
      sources.some((s) => s.includes('attributesOfItem')),
      'the scan found no file metadata call; this test would pass vacuously'
    );
    for (const [name, file] of Object.entries(manifests)) {
      const reasons = accessedApiReasons(read(file), 'NSPrivacyAccessedAPICategoryFileTimestamp');
      assert.ok(reasons, `${name} does not declare the file timestamp category`);
      assert.ok(reasons.includes('C617.1'), `${name} is missing reason C617.1`);
    }
  });

  it('宣言していない要理由APIを新たに使い始めたら落ちる', () => {
    // The categories this app does not use today. If one appears in the source
    // without a matching declaration, the manifest has gone stale.
    const undeclared = {
      NSPrivacyAccessedAPICategoryDiskSpace: [
        'volumeAvailableCapacity', 'systemFreeSize', 'statfs(', 'volumeTotalCapacity',
      ],
      NSPrivacyAccessedAPICategorySystemBootTime: [
        'kern.boottime', 'systemUptime', 'mach_absolute_time',
      ],
      NSPrivacyAccessedAPICategoryActiveKeyboards: [
        'activeInputModes', 'TISCopyCurrentKeyboard',
      ],
    };
    const sources = swiftSources();
    for (const [category, needles] of Object.entries(undeclared)) {
      const used = needles.filter((needle) => sources.some((s) => s.includes(needle)));
      const declared = accessedApiReasons(read(manifests.host), category) !== null;
      assert.ok(
        used.length === 0 || declared,
        `${category} is used (${used.join(', ')}) but not declared in the privacy manifest`
      );
    }
  });
});
