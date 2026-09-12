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

describe('通信ログが新しい通信に追従する', () => {
  const appDelegate = readAgentSource('AgentAppDelegate.swift');

  it('取り込みの経路から知らされる。問い合わせて回らない', () => {
    // The rows are already in the store when the collector's delivery runs.
    // Asking the database every second whether anything changed would be work
    // that is almost always wasted, and frequent polling of an expensive
    // answer is what took the Windows IPC listener down in P3-106.
    assert.match(appDelegate, /observationWindow\?\.observationsArrived\(observations\.count\)/);
    assert.match(viewModel, /func observationsArrived\(_ count: Int\)/);
  });

  it('見ていない画面のためには読まない', () => {
    // Not the log tab, or no window: nothing to update, so nothing is read.
    assert.match(
      viewModel,
      /guard count > 0, selectedTab == \.log, isWindowVisible else \{ return \}/
    );
  });

  it('まとめて届いても読み出しは1回', () => {
    assert.match(viewModel, /private var liveLogPacer = LiveLogPacer\(\)/);
    assert.match(viewModel, /guard let delay = liveLogPacer\.schedule\(\) else \{ return \}/);
  });

  it('待っている間に条件が変わったら、予約を取り消したと伝える', () => {
    // Left as "still pending", the pacer would never schedule another read
    // and the log would stop updating without saying so.
    assert.match(viewModel, /self\.liveLogPacer\.cancelled\(\)/);
    assert.match(viewModel, /self\.liveLogPacer\.refreshed\(\)/);
  });

  it('止めている間は読まず、数えるだけ', () => {
    // Pausing the screen and carrying on in the background would spend the
    // battery on rows nobody is going to see.
    assert.match(viewModel, /logPendingArrivals \+= count/);
    assert.match(viewModel, /func setLogPaused\(_ paused: Bool\)/);
  });

  it('画面がいまの状態を自分で述べる', () => {
    assert.match(window, /private var liveStateText: String/);
    assert.match(window, /L\("Live -- updated %@"/);
    assert.match(window, /L\("Paused -- %lld new"/);
    assert.match(window, /Button\(model\.logIsPaused \? L\("Resume"\) : L\("Pause"\)\)/);
    for (const language of ['en', 'ja']) {
      for (const key of ['"Live"', '"Live -- updated %@"', '"Paused"', '"Paused -- %lld new"', '"Resume"']) {
        assert.ok(strings(language).includes(`${key} =`), `${language}: ${key}`);
      }
    }
  });

  it('行の同一性が更新で変わらない', () => {
    // An id holding the last-observed time and the row index changed on every
    // reload, so every row was a new row. A log that reloads as traffic
    // arrives would have thrown the table away several times a minute.
    assert.match(viewModel, /id: observation\.flowID\?\.uuidString/);
    assert.doesNotMatch(viewModel, /id: "\\\(observation\.stableKey\)\|\\\(observation\.lastObservedAt/);
  });
});
