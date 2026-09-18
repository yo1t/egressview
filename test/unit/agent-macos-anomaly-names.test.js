'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { readAgentSource, agentRoot } = require('../helpers/agent-macos-sources.js');

const notifier = readAgentSource('AgentUserNotifier.swift');
const store = readAgentSource('ObservationStore.swift');
const strings = language => fs.readFileSync(
  path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
);

// The first real detection, on 2026-09-16, said "845.6 MB against a usual
// 674 KB" and nothing else. It was a speed test and a film. The reader had no
// way to know that from the notice (P3-122).
describe('送信異常の通知は、何がどこへ出たかを言う', () => {
  it('窓の中の送信元と宛先を集計する', () => {
    assert.match(store, /public func outboundWindowContributors\(/);
    assert.match(store, /GROUP BY name\n\s*HAVING sent > 0\n\s*ORDER BY sent DESC/);
  });

  it('通知の本文に名前を入れる', () => {
    assert.match(notifier, /let culprits = OutboundAnomalyWording\.contributorLine\(report\)/);
    assert.match(notifier, /reason: culprits\.isEmpty \? reason : reason \+ "\\n" \+ culprits/);
  });

  it('名前が取れないときは、数字だけの通知に戻る', () => {
    // A window whose raw rows have already been compacted away must still
    // produce a notice, rather than none at all.
    assert.match(notifier, /guard let application = report\.applications\.first else \{ return "" \}/);
    assert.match(notifier, /let contributors = try\? store\.outboundWindowContributors\(/);
  });

  it('宛先の総数も述べる', () => {
    assert.match(notifier, /and %lld other destinations/);
    for (const language of ['en', 'ja']) {
      assert.ok(
        strings(language).includes('"Mostly %@ (%@), to %@ and %lld other destinations." ='),
        language
      );
    }
  });

  it('断定しない言い方は残っている', () => {
    assert.match(notifier, /This is a behavioural anomaly, not a malware verdict/);
    assert.match(notifier, /Open Network status or Connection log to review/);
  });
});
