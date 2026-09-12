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
    assert.match(viewModel, /var activityText: String \{ isRunning \? L\("still running"\) : "" \}/);
    // The time column holds the time and nothing else. Taken up to the
    // column's own `.width`, so the comment introducing the next column is
    // not mistaken for part of this cell.
    const lastSeen = window.slice(window.indexOf('TableColumn(L("Last seen")'));
    const cell = lastSeen.slice(0, lastSeen.indexOf('.width('));
    assert.doesNotMatch(cell, /still running|activityText|isRunning/);
  });

  it('継続中かどうかを、壁時計ではなく行を読んだ時点で判定する', () => {
    // Judged against `Date()` at draw time, the marker would switch off as
    // the 15 second refresh timer ran down -- reporting the timer rather than
    // the connection. The row carries the moment the page was read instead.
    assert.match(viewModel, /let snapshotTakenAt: Date/);
    assert.match(viewModel, /snapshotTakenAt: snapshotTakenAt/);
    assert.match(viewModel, /let snapshotTakenAt = Date\(\)/);
    assert.match(
      viewModel,
      /ConnectionLogActivity\.isRunning\(\s*lastObservedAt: observation\.lastObservedAt, snapshotTakenAt: snapshotTakenAt\s*\)/
    );
    // One time for the whole page. Rows read together must agree about what
    // counts as running.
    assert.equal((viewModel.match(/let snapshotTakenAt = Date\(\)/g) || []).length, 1);
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
      assert.ok(table.includes('"still running" ='), `${language}: still running`);
      assert.ok(table.includes('"State" ='), `${language}: State`);
      assert.ok(table.includes('"First seen" ='), `${language}: First seen`);
      assert.ok(table.includes('"Last seen" ='), `${language}: Last seen`);
    }
    assert.notEqual(
      strings('ja').match(/"still running" = "([^"]*)"/)[1],
      'still running',
      'ja が英語のまま'
    );
  });
});
