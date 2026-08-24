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

  it('何が失われて何が残るかを、実際のとおりに書いてある', () => {
    // The note claimed destinations become addresses. That stopped being true
    // when `chart_hourly` arrived: it keeps the name and covers every folded
    // hour. Measured on a real store -- 91,695 chart rows, 62,458 with a name,
    // and no rolled-up hour outside them. What ages out is the individual
    // connections, not what they were called.
    assert.match(components, /Individual connections there have aged out/);
    assert.match(components, /Destinations keep their names/);
    assert.doesNotMatch(components, /destinations are shown as addresses/);
  });
});
