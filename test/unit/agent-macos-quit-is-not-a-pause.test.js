'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { readAgentSource } = require('../helpers/agent-macos-sources.js');

const delegate = readAgentSource('AgentAppDelegate.swift');
const monitoring = readAgentSource('AgentMonitoringController.swift');
const resume = readAgentSource('MonitoringResumeState.swift');

// Until 2026-09-13 "Quit" called the same pause() the Pause menu item calls,
// and the launch path read the filter's state as the user's wish. So quitting
// left monitoring off, and looked like a pause nobody had chosen (P3-121).
describe('終了は、選んでいない一時停止に見えてはいけない', () => {
  it('終了は、動いていたモードを控えてから止める', () => {
    assert.match(delegate, /controller\.pauseForQuit\(/);
    assert.doesNotMatch(delegate, /func quit\(\) \{\n\s*controller\.pause\(\)/);
    assert.match(monitoring, /func pauseForQuit\(mode: String\?\) \{[\s\S]*?resumeState\.modeBeforeQuit = mode[\s\S]*?pause\(\)/);
  });

  it('終了でフィルタは外れたままにしない（次回起動で戻す）', () => {
    // The filter still goes down on quit -- that is the decision, and it is
    // why this is about the note and not about leaving it running.
    assert.match(monitoring, /resumeState\.takeModeBeforeQuit\(\)/);
    assert.match(monitoring, /case "full":[\s\S]*?activateFullMonitoring\(\)/);
    assert.match(monitoring, /case "lightweight":[\s\S]*?selectLightweightMonitoring\(\)/);
  });

  it('一時停止は、控えを消して止まったままになる', () => {
    assert.match(monitoring, /func pause\(\) \{\n\s*\/\/[\s\S]*?resumeState\.modeBeforeQuit = nil/);
  });

  it('控えが無ければ、何も再開しない', () => {
    // Turning the extension off in System Settings is how uninstalling starts.
    // Re-asking for approval at every login would fight our own instructions.
    assert.match(resume, /public func takeModeBeforeQuit\(\) -> String\?/);
    assert.match(monitoring, /default:\n\s*break\n\s*\}\n\s*extensionController\.isFilterEnabled/);
  });

  it('控えは一度しか使わない', () => {
    assert.match(resume, /let mode = modeBeforeQuit\n\s*modeBeforeQuit = nil\n\s*return mode/);
  });

  it('窓を閉じても終了しない（回帰させない）', () => {
    // The other half of the same question: closing the window must keep
    // recording, so the agent must not terminate with its last window.
    assert.doesNotMatch(delegate, /applicationShouldTerminateAfterLastWindowClosed[\s\S]{0,120}true/);
  });
});
