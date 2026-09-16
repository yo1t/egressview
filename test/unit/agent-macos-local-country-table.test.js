'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { readAgentSource, agentRoot } = require('../helpers/agent-macos-sources.js');

const settings = readAgentSource('HubDeliveryController.swift');
const updater = readAgentSource('GeoLite2Updater.swift');
const local = readAgentSource('LocalCountryDatabase.swift');
const strings = language => fs.readFileSync(
  path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
);

// The point of a table on this Mac: the question never leaves it (P3-117).
describe('このMacの国テーブル', () => {
  it('使うかどうかを選べ、既定は使わない', () => {
    // It only works with the reader's own MaxMind account, so it cannot be on
    // by default.
    assert.match(settings, /Toggle\(isOn: \$model\.usesLocalCountryTable\)/);
    assert.match(
      settings, /usesLocalCountryTable = GeoCachePreferences\(\)\.localTableEnabled/
    );
  });

  it('まずこのMacに聞き、答えられない分だけ外に出す', () => {
    assert.match(settings, /let stillUnknown = resolveFromLocalTable\(\)/);
    assert.match(settings, /guard stillUnknown else \{ return \}/);
    assert.match(settings, /localTable\.countryCode\(for: address\)/);
  });

  it('外へ出るのは資格情報だけだと述べている', () => {
    for (const language of ['en', 'ja']) {
      assert.ok(
        strings(language).includes(
          '"Only your account ID and licence key are sent to MaxMind. No watched address leaves this Mac." ='
        ),
        language
      );
    }
    assert.match(settings, /Only your account ID and licence key are sent to MaxMind/);
  });

  it('鍵はKeychainに置き、URLには入れない', () => {
    assert.match(updater, /GeoLite2CredentialStore/);
    assert.match(updater, /KeychainAgentAPIKeyStore\(\n?\s*service: "com\.egressview\.agent\.maxmind"/);
    assert.match(updater, /request\.setValue\("Basic \\\(encoded\)", forHTTPHeaderField: "Authorization"\)/);
  });

  it('読めないものを設置しない', () => {
    // A proxy error page must not replace a working table.
    assert.match(updater, /return \(database, try MaxMindDB\(bytes: database\)\.metadata\)/);
    assert.match(updater, /replaceItemAt\(url, withItemAt: temporary\)/);
  });

  it('30日を超えた版は使わない', () => {
    // The licence requires destroying a build more than thirty days behind.
    assert.match(local, /public static let maximumAge: TimeInterval = 30 \* 24 \* 60 \* 60/);
    assert.match(local, /database\.metadata\.age\(now: now\) <= Self\.maximumAge/);
  });

  it('出典表示が画面にある', () => {
    assert.match(local, /This product includes GeoLite Data created by MaxMind/);
    assert.match(settings, /Text\(LocalCountryDatabase\.attribution\)/);
  });

  it('座標の無い行で地球儀に弧を描かない', () => {
    const store = readAgentSource('ObservationStore.swift');
    assert.match(store, /JOIN geo_locations g ON g\.ip = c\.remote_address AND g\.latitude IS NOT NULL/);
    // ...and that traffic is still counted, rather than vanishing from the
    // globe's own accounting because a row happens to exist.
    assert.match(store, /WHERE g\.ip = c\.remote_address AND g\.latitude IS NOT NULL/);
  });

  it('断られた理由を、MaxMindの言葉で伝える', () => {
    // Seen on 2026-09-16: the agent said only "MaxMind refused that account ID
    // and licence key", which cannot tell a mistyped key from an account that
    // cannot reach this edition. MaxMind says which, in one sentence.
    assert.match(updater, /case unauthorised\(String\)/);
    assert.match(updater, /case httpStatus\(Int, String\)/);
    assert.match(updater, /static func reason\(from data: Data\) -> String/);
    assert.match(settings, /reason\.isEmpty\n\s*\? L\("MaxMind refused that account ID and licence key\."\)/);
  });

  it('MaxMindのGeoIP.confをそのまま読める', () => {
    // The key is forty characters and is shown once. Retyping it is where the
    // first real attempt failed (2026-09-16).
    assert.match(updater, /public init\?\(configuration: String\)/);
    assert.match(settings, /Button\(L\("Read GeoIP\.conf\.\.\."\)\)/);
    assert.match(settings, /func importConfiguration\(at url: URL\) async/);
    assert.match(settings, /GeoLite2Updater\.Credentials\(configuration: text\)/);
  });

  it('手順が両方のREADMEに書いてある', () => {
    const root = path.join(agentRoot, '..', '..');
    const ja = fs.readFileSync(path.join(agentRoot, 'README.ja.md'), 'utf8');
    const en = fs.readFileSync(path.join(agentRoot, 'README.md'), 'utf8');
    assert.match(ja, /GeoIP\.conf を読み込む/);
    assert.match(ja, /週に1回、自動で取り直します/);
    assert.match(ja, /監視対象のアドレスは\*\*1件も送りません\*\*/);
    assert.match(en, /Read GeoIP\.conf/);
    assert.match(en, /It refreshes weekly/);
    assert.match(en, /No watched\naddress is sent/);
    assert.ok(root);
  });

  it('既存の経路は残っている', () => {
    assert.match(settings, /When an address is not in the cache/);
    assert.match(settings, /ThirdPartyGeoLookup\(/);
  });
});
