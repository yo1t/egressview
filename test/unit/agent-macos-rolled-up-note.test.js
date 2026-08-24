'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hostDir = path.join(__dirname, '..', '..', 'apps/agent-macos/Xcode/Host');
const read = (f) => fs.readFileSync(path.join(hostDir, f), 'utf8');
const window = read('ObservationWindowController.swift');
const viewModel = read('AgentMainViewModel.swift');
const components = read('AgentChartComponents.swift');

describe('古い期間が時間集計であることを画面が言う', () => {
  it('計算した答えが画面まで届いている', () => {
    // Found 2026-08-24: the store answered `periodUsesRolledUpHistory`, the
    // view model published it, the note view existed -- and nothing rendered
    // it. Individual records age out at 14 days, so the connection log for an
    // older period goes quiet with no reason given, which reads as "nothing
    // happened" rather than "this part is kept as hourly totals".
    assert.match(viewModel, /usesRolledUpHistory = try store\.periodUsesRolledUpHistory/);
    assert.match(window, /AgentRolledUpHistoryNote\(applies: usesRolledUpHistory\)/);
    assert.match(window, /usesRolledUpHistory: model\.usesRolledUpHistory/);
  });

  it('何が読めなくなるかまで書いてある', () => {
    // "This is rolled up" alone would leave the reader to work out what that
    // costs them. Names and anything shorter than an hour are what it costs.
    assert.match(components, /kept as hourly totals/);
    assert.match(components, /destinations are shown as addresses/);
    assert.match(components, /nothing shorter than an hour is separated out/);
  });
});
