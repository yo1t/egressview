'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { readAgentSource, agentRoot } = require('../helpers/agent-macos-sources.js');

const fetcher = readAgentSource('GeoCacheFetcher.swift');
const settings = readAgentSource('HubDeliveryController.swift');
const appDelegate = readAgentSource('AgentAppDelegate.swift');
const lookup = readAgentSource('ThirdPartyGeoLookup.swift');
const strings = (language) => fs.readFileSync(
  path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
);

describe('キャッシュに無い国を取りに行く', () => {
  it('第三者への問い合わせが、実際に実装されている', () => {
    // The toggle and the README promised this for months while nothing read
    // the setting: the string "ip-api.com" appeared only in the UI text. A
    // setting that is wired to nothing is the defect found three times over
    // on 2026-08-24 (P3-115).
    assert.match(lookup, /func locate\(_ addresses: \[String\], budget: Int/);
    assert.match(lookup, /ipwho\.is/);
    assert.match(settings, /ThirdPartyGeoLookup\(/);
  });

  it('観測が届いたときに、名前のない宛先を取りに行く', () => {
    assert.match(appDelegate, /geoCacheController\.resolveNewDestinations\(\)/);
    assert.match(settings, /func resolveNewDestinations\(\) async/);
    assert.match(settings, /store\.pendingCountryAddresses\(/);
  });

  it('外へ出すのは、選んだときだけ', () => {
    // The Hub path must not reach a third party, whatever the queue holds.
    assert.match(fetcher, /case hubThenThirdParty/);
    assert.match(fetcher, /public var usesThirdParty: Bool \{ self == \.hubThenThirdParty \}/);
    assert.match(settings, /guard source\.usesThirdParty else \{ return \}/);
  });

  it('既定は外へ出さない', () => {
    assert.match(fetcher, /return thirdPartyLookupEnabled \? \.hubThenThirdParty : \.hub/);
  });

  it('短い間隔で何度も問い合わせない', () => {
    assert.match(fetcher, /public static let onDemandInterval: TimeInterval = 60/);
    assert.match(fetcher, /func shouldFetchOnDemand\(/);
    assert.match(settings, /preferences\.lastOnDemandAt = Date\(\)/);
  });

  it('一日一回の一括取得は残っている', () => {
    // On-demand is an addition, not a replacement.
    assert.match(fetcher, /public static let fetchInterval: TimeInterval = 24 \* 60 \* 60/);
  });

  it('設定画面に3択があり、外へ出る選択肢がそう言っている', () => {
    assert.match(settings, /Picker\(L\("When an address is not in the cache"\)/);
    assert.match(settings, /model\.geoLookupSource\.usesThirdParty \? \.orange : \.secondary/);
    for (const language of ['en', 'ja']) {
      for (const key of ['"Do not look it up"', '"Ask the Hub"', '"Ask the Hub, then ipwho.is"']) {
        assert.ok(strings(language).includes(`${key} =`), `${language}: ${key}`);
      }
    }
    const japanese = strings('ja');
    assert.match(japanese, /監視対象のアドレスを外部へ送るのは、この設定だけです/);
    assert.doesNotMatch(strings('ja'), /ip-api\.com/);
  });


  it('平文HTTPでは問い合わせない', () => {
    // ip-api.com's free tier answers over plain HTTP only, so App Transport
    // Security refused every request and the settings screen showed a raw
    // NSError before the user had touched anything (2026-09-13). Sending
    // watched addresses in clear text was never the alternative.
    assert.match(lookup, /base: URL = URL\(string: "https:\/\/ipwho\.is"\)!/);
    assert.doesNotMatch(lookup, /http:\/\//);
  });

  it('一日に外へ出す件数に上限がある', () => {
    // The free tier is 1,000 requests a day with no bulk endpoint: one
    // request is one address.
    assert.match(lookup, /public static let dailyBudget = 500/);
    assert.match(settings, /preferences\.thirdPartyBudget\(/);
    assert.match(settings, /preferences\.recordThirdPartySpend\(/);
    assert.match(fetcher, /func thirdPartyBudget\(on day: String, limit: Int, perRun: Int\) -> Int/);
  });

  it('誰も頼んでいない失敗を画面に貼り付けない', () => {
    // The lookup runs on its own when an observation arrives, so a failure
    // has no reader waiting for it. The free tier carries no uptime
    // guarantee; the addresses stay in the queue.
    assert.match(settings, /NSLog\("EgressView: third-party location lookup failed/);
  });

  it('生のNSErrorを読ませない', () => {
    assert.doesNotMatch(settings, /return String\(describing: error\)/);
    assert.match(settings, /localizedDescription/);
    for (const language of ['en', 'ja']) {
      assert.ok(strings(language).includes('"Could not fetch locations: %@" ='), language);
    }
  });

  it('使われなくなった文言を残さない', () => {
    for (const language of ['en', 'ja']) {
      assert.doesNotMatch(strings(language), /"Look up locations without a Hub" =/);
    }
  });
});
