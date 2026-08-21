'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const hostDir = path.join(__dirname, '..', '..', 'apps/agent-macos/Xcode/Host');
const read = (f) => fs.readFileSync(path.join(hostDir, f), 'utf8');
const window = read('ObservationWindowController.swift');
const collector = read('FullMonitoringCollector.swift');
const appDelegate = read('AgentAppDelegate.swift');
const settings = read('HubDeliveryController.swift');

// Measured 2026-08-20: 41% CPU and 325 MB after a day, with no window open,
// back to 2% and 162 MB on restart. The hosting controller is held for the life
// of the app, so nothing tears the view down when the window closes -- whatever
// keeps working has to be told to stop.
describe('macOS Agent idle cost', () => {
  it('地球儀は画面に出ていないときは回らない', () => {
    // controlActiveState reports whether the *application* is active, not
    // whether this window is on screen, so it never stopped on close.
    assert.match(window, /let isOnScreen: Bool/);
    assert.match(window, /isAnimating: Bool \{\s*\n?\s*isOnScreen && isRunning/);
    assert.match(window, /isOnScreen: model\.isWindowVisible && model\.selectedTab == \.network/);
  });

  it('可視状態はビューへ伝わる', () => {
    // As a plain property the change reached the query throttle and never the
    // view, so the animation carried on regardless.
    assert.match(window, /@Published var isWindowVisible = true/);
  });

  it('ウィンドウを開き直したら可視状態が戻る', () => {
    const show = window.slice(window.indexOf('    func show() {'), window.indexOf('    func noteObservationsAvailable'));
    assert.match(show, /model\.isWindowVisible = true/);
  });

  it('XPC取得は前回の応答を待ち、返らなければ接続を張り直す', () => {
    assert.match(collector, /guard !isDraining else \{ return \}/);
    assert.match(collector, /drainTimeout/);
    // Every exit from a drain must clear the flag, or polling stops for good.
    assert.ok((collector.match(/isDraining = false/g) || []).length >= 4);
  });

  it('SwiftUIウィンドウは表示まで生成せず閉じたら解放する', () => {
    assert.match(appDelegate, /private var observationWindow: ObservationWindowController\?/);
    assert.match(appDelegate, /private var settingsWindow: SettingsWindowController\?/);
    assert.doesNotMatch(appDelegate, /private lazy var (observationWindow|settingsWindow)/);
    assert.match(appDelegate, /self\?\.observationWindow = nil/);
    assert.match(appDelegate, /self\?\.settingsWindow = nil/);
    assert.match(window, /func windowWillClose[\s\S]*?onClose\(\)/);
    assert.match(settings, /func windowWillClose[\s\S]*?onClose\(\)/);
  });

  it('ウィンドウを閉じる処理の中でコントローラを解放しない', () => {
    // AppKit is still closing the window when windowWillClose runs, and the
    // callback drops the last reference to the controller that owns it.
    const settings = read('HubDeliveryController.swift');
    for (const [name, source] of [['observation', window], ['settings', settings]]) {
      const close = source.slice(source.lastIndexOf('func windowWillClose'));
      assert.match(close, /DispatchQueue\.main\.async \{ \[onClose\] in onClose\(\) \}/, name);
    }
  });

  it('地球儀は設定可能な専用NSViewで非同期描画する', () => {
    assert.doesNotMatch(window, /TimelineView\(\.animation/);
    assert.match(window, /private struct AgentGlobeNativeView: NSViewRepresentable/);
    assert.match(window, /private final class AgentGlobeDrawingView: NSView/);
    assert.match(window, /layer\?\.drawsAsynchronously = true/);
    assert.match(window, /case energySaver = 3/);
    assert.match(window, /case standard = 5/);
    assert.match(window, /case smooth = 15/);
    assert.match(window, /Timer\(timeInterval: interval, repeats: true\)/);
    assert.match(settings, /@AppStorage\(AgentGlobeFrameRate\.defaultsKey\)/);
    assert.match(settings, /Picker\(L\("Frame rate"\), selection: \$globeFrameRateRaw\)/);
  });
});
