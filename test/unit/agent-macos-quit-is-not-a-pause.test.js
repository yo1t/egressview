'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { readAgentSource } = require('../helpers/agent-macos-sources.js');

const delegate = readAgentSource('AgentAppDelegate.swift');
const monitoring = readAgentSource('AgentMonitoringController.swift');
const preference = readAgentSource('MonitoringModePreference.swift');

// Until 2026-09-13 nothing stored what the user had asked for. The launch path
// asked macOS whether the filter was enabled and took that as the wish, so a
// quit -- which disables the filter on purpose -- was indistinguishable from a
// Pause nobody had chosen, and monitoring stayed off (P3-121).
describe('終了は、選んでいない一時停止に見えてはいけない', () => {
  it('終了は設定に触らない', () => {
    assert.match(
      delegate,
      /@objc private func quit\(\) \{[\s\S]*?controller\.pause\(\)\n\s*NSApplication\.shared\.terminate/
    );
    const quitBody = /@objc private func quit\(\) \{([\s\S]*?)\n {4}\}/.exec(delegate)[1];
    assert.doesNotMatch(quitBody, /rememberChosenMode/, '終了がモード設定を書き換えている');
  });

  it('一時停止は設定として残る', () => {
    assert.match(
      delegate,
      /@objc private func selectPaused\(\)[\s\S]*?controller\.rememberChosenMode\(\.paused\)[\s\S]*?controller\.pause\(\)/
    );
  });

  it('監視を選んだときも設定に残る', () => {
    assert.match(monitoring, /func selectFullMonitoring\(\) \{[\s\S]*?rememberChosenMode\(\.full\)/);
    assert.match(monitoring, /func selectLightweightMonitoring\(\) \{\n\s*rememberChosenMode\(\.lightweight\)/);
  });

  it('起動時は、macOSの状態ではなく設定に従う', () => {
    assert.match(monitoring, /switch modePreference\.storedMode \{/);
    assert.match(monitoring, /case AgentMonitoringMode\.full\.rawValue:[\s\S]*?activateFullMonitoring\(\)/);
    assert.match(monitoring, /case AgentMonitoringMode\.paused\.rawValue:[\s\S]*?statusHandler\(\.paused\)/);
  });

  it('誰も選んでいなければ、macOSに聞く', () => {
    // A first run, or an upgrade from a version that never wrote the setting.
    // Inventing "paused" there would turn monitoring off for people who had it.
    assert.match(monitoring, /default:\n\s*break\n\s*\}\n\s*extensionController\.isFilterEnabled/);
  });

  it('アンインストールに入るときは監視を残さない', () => {
    // A half-removed agent must not ask to approve an extension on its way out.
    assert.match(
      monitoring,
      /func prepareForUninstall\(completion[\s\S]*?rememberChosenMode\(\.paused\)/
    );
  });

  it('窓を閉じても終了しない（回帰させない）', () => {
    assert.doesNotMatch(delegate, /applicationShouldTerminateAfterLastWindowClosed[\s\S]{0,120}true/);
  });
});
