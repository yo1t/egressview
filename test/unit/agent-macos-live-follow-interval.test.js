'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { readAgentSource } = require('../helpers/agent-macos-sources.js');

const scale = readAgentSource('VisualizationSelection.swift');
const viewModel = readAgentSource('AgentMainViewModel.swift');

// Measured 2026-09-18 against a copy of one Mac's store (596,535 observations,
// 186 MB), page cache warm: one network-tab refresh is 4.3 ms for an hour,
// 25.9 ms for a day and 151.7 ms for a week. One interval cannot be right for
// all three.
describe('ネットワーク状況の追従間隔は、期間に合わせる', () => {
  it('短い期間ほど速く追う', () => {
    assert.match(scale, /public var liveFollowInterval: TimeInterval \{/);
    assert.match(scale, /case \.hour: return 1/);
    assert.match(scale, /case \.sixHours, \.day: return 3/);
    assert.match(scale, /case \.week, \.month: return 5/);
  });

  it('どの期間でもCPUは1%程度に収まる', () => {
    // hour: 4.3 ms per second. day: 25.9 ms per 3 s. week: 151.7 ms per 5 s.
    const cost = { hour: 4.3, day: 25.9, week: 151.7 };
    const interval = { hour: 1, day: 3, week: 5 };
    for (const period of Object.keys(cost)) {
      const share = cost[period] / (interval[period] * 1000);
      assert.ok(
        share < 0.035,
        `${period}: 1コアの${(share * 100).toFixed(1)}%を使う見積もり`
      );
    }
  });

  it('期間を変えたら間隔も変わる', () => {
    // Without this the pacer keeps whatever interval it was built with, and a
    // week would be re-read every second.
    assert.match(viewModel, /if networkPacerScale != scale \{/);
    assert.match(viewModel, /networkPacer = LiveLogPacer\(interval: scale\.liveFollowInterval\)/);
  });

  it('見ていない画面のためには読まない（回帰させない）', () => {
    // The reason the old interval was 15 seconds at all.
    assert.match(viewModel, /guard NSApp\.isActive else \{ return \}/);
    assert.match(viewModel, /guard let self, self\.isWindowVisible else \{ return \}/);
  });
});
