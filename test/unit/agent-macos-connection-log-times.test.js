'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { readAgentSource, agentRoot } = require('../helpers/agent-macos-sources.js');

const window = readAgentSource('ObservationWindowController.swift');
const viewModel = readAgentSource('AgentMainViewModel.swift');
const strings = (language) => fs.readFileSync(
  path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
);

describe('通信ログが行の期間を語る', () => {
  it('最初と最後の両方を列にしている', () => {
    // One time column could not say whether a row was a moment or an hour,
    // and the row is an aggregate that keeps being updated (P3-107).
    assert.match(window, /TableColumn\(L\("First seen"\), value: \\\.firstObservedAt\)/);
    assert.match(window, /TableColumn\(L\("Last seen"\), value: \\\.lastObservedAt\)/);
    assert.match(viewModel, /var firstObservedAt: Date \{ observation\.firstObservedAt \}/);
    assert.match(viewModel, /var lastObservedAt: Date \{ observation\.lastObservedAt \}/);
  });

  it('継続中は独立した列である', () => {
    // Without it, a finished connection and a running one look identical.
    // Inside the time column, the cell holds a timestamp and a state as one
    // value: it sorts by neither, and anything copying the table out -- a
    // selection, a spreadsheet, a later export -- carries the pair glued
    // together.
    assert.match(window, /TableColumn\(L\("State"\), value: \\\.activityText\)/);
    assert.match(viewModel, /var activityText: String \{ isOpen \? L\("not ended"\) : "" \}/);
    // The time column holds the time and nothing else. Taken up to the
    // column's own `.width`, so the comment introducing the next column is
    // not mistaken for part of this cell.
    const lastSeen = window.slice(window.indexOf('TableColumn(L("Last seen")'));
    const cell = lastSeen.slice(0, lastSeen.indexOf('.width('));
    assert.doesNotMatch(cell, /not ended|activityText|isOpen/);
  });

  it('終わったかどうかを、時刻の新しさでは判定しない', () => {
    // A flow is reported twice, at open and at close, and nothing moves its
    // last-observed time in between. Judged by recency, a connection open for
    // an hour reads as finished and one that ended a second ago reads as
    // running -- the opposite of the truth, twice.
    assert.match(viewModel, /var isOpen: Bool \{ ConnectionLogActivity\.isOpen\(observation\) \}/);
    assert.doesNotMatch(viewModel, /snapshotTakenAt/);
    assert.doesNotMatch(window, /snapshotTakenAt/);
  });

  it('既定は最終観測の降順', () => {
    assert.match(
      viewModel,
      /logSort = \[KeyPathComparator\(\\AgentObservationRow\.lastObservedAt, order: \.reverse\)\]/
    );
  });

  it('新しい文言が両方の言語にある', () => {
    // A key missing from ja shows the key itself, which is an English
    // sentence -- so the failure looks like success.
    for (const language of ['en', 'ja']) {
      const table = strings(language);
      assert.ok(table.includes('"not ended" ='), `${language}: not ended`);
      assert.ok(table.includes('"State" ='), `${language}: State`);
      assert.ok(table.includes('"First seen" ='), `${language}: First seen`);
      assert.ok(table.includes('"Last seen" ='), `${language}: Last seen`);
    }
    assert.notEqual(
      strings('ja').match(/"not ended" = "([^"]*)"/)[1],
      'not ended',
      'ja が英語のまま'
    );
  });
});
