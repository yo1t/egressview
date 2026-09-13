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
    assert.match(viewModel, /var activityText: String \{ isOpen \? L\("end not seen"\) : "" \}/);
    // The time column holds the time and nothing else. Taken up to the
    // column's own `.width`, so the comment introducing the next column is
    // not mistaken for part of this cell.
    const lastSeen = window.slice(window.indexOf('TableColumn(L("Last seen")'));
    const cell = lastSeen.slice(0, lastSeen.indexOf('.width('));
    assert.doesNotMatch(cell, /end not seen|activityText|isOpen/);
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
      assert.ok(table.includes('"end not seen" ='), `${language}: end not seen`);
      assert.ok(table.includes('"State" ='), `${language}: State`);
      assert.ok(table.includes('"First seen" ='), `${language}: First seen`);
      assert.ok(table.includes('"Last seen" ='), `${language}: Last seen`);
    }
    assert.notEqual(
      strings('ja').match(/"end not seen" = "([^"]*)"/)[1],
      'end not seen',
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
    assert.match(appDelegate, /observationWindow\?\.observationsArrived\(observations\)/);
    assert.match(viewModel, /func observationsArrived\(_ observations: \[ConnectionObservation\]\)/);
  });

  it('見ていない画面のためには読まない', () => {
    // No window: nothing to update, so nothing is read. The map has its own
    // condition -- it is expanded or it is not (P3-109) -- so the two are
    // separate guards rather than one.
    assert.match(viewModel, /guard !observations\.isEmpty, isWindowVisible else \{ return \}/);
    // Only the tab in front follows arrivals, and only while the app is the
    // one being used. Reading for a screen nobody is looking at is the work
    // that made this app the busiest process on the Mac in 0.4.x, and the
    // timer already slows to a quarter in the background -- following arrivals
    // there would undo that. A tab not listed here falls through to `default`
    // and reads nothing.
    assert.match(viewModel, /guard NSApp\.isActive else \{ return \}/);
    assert.match(viewModel, /switch selectedTab \{/);
    assert.match(viewModel, /case \.log:/);
    assert.match(viewModel, /case \.network:\s*\n\s*scheduleNetworkRefresh\(\)/);
    assert.match(viewModel, /default:\s*\n\s*return/);
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

  it('ネットワーク状況も同じ規則で、独自の間隔で追従する', () => {
    // "This period at a glance" and the app-to-destination ribbon redrew on
    // the 15-second timer, so a connection just made could be missing from a
    // screen being watched. They follow arrivals now -- through the same
    // pacer, at a slower pace, because totals are not read line by line the
    // way individual connections are.
    assert.match(viewModel, /static let networkFollowInterval: TimeInterval = 5/);
    assert.match(
      viewModel,
      /private var networkPacer = LiveLogPacer\(interval: AgentMainViewModel\.networkFollowInterval\)/
    );
    // The same cancel/refresh pair the log needs, for the same reason: a read
    // abandoned when the tab changes must not leave the pacer believing one is
    // still coming.
    assert.match(viewModel, /self\.networkPacer\.cancelled\(\)/);
    assert.match(viewModel, /self\.networkPacer\.refreshed\(\)/);
    assert.match(
      viewModel,
      /guard self\.selectedTab == \.network, self\.isWindowVisible, NSApp\.isActive else \{/
    );
  });

  it('通信が無い間もタイマーが下限として残る', () => {
    // An idle network still has to move "the last hour" forward. A tab that
    // only redrew on traffic would freeze on a quiet machine, which is why
    // following arrivals is added to the timer rather than replacing it.
    assert.match(viewModel, /refreshTimer\.start\(every: 15\)/);
    assert.match(viewModel, /guard self\.ticksSinceRefresh >= 4 else \{ return \}/);
  });

  it('止めている間は読まず、数えるだけ', () => {
    // Pausing the screen and carrying on in the background would spend the
    // battery on rows nobody is going to see.
    assert.match(viewModel, /logPendingArrivals \+= observations\.count/);
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
