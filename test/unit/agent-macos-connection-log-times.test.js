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

  it('継続中の行がそうと分かる', () => {
    // Without the marker a finished connection and a running one look
    // identical, and the moving number reads as a wrong one.
    assert.match(window, /ConnectionLogActivity\.isRunning\(/);
    assert.match(window, /L\("still running"\)/);
  });

  it('継続中かどうかを、壁時計ではなく画面の時点で判定する', () => {
    // Judged against `Date()`, the marker would switch off as the 15 second
    // refresh timer ran down, reporting the timer rather than the connection.
    assert.match(window, /snapshotTakenAt: model\.rowsLoadedAt/);
    assert.doesNotMatch(window, /snapshotTakenAt: Date\(\)/);
    assert.match(viewModel, /rowsLoadedAt = Date\(\)/);
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
