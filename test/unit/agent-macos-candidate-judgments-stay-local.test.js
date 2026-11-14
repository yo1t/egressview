'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { agentRoot } = require('../helpers/agent-macos-sources.js');

// A note on a candidate can name people, places and projects. The answer and
// the note are for the person on this Mac only: the screen that shows them
// may read them, and nothing that leaves the Mac -- Hub delivery, the AI
// context, the diagnostics report, notifications -- may (P3-194).
const allowed = [
  'Sources/EgressViewAgentCore/ObservationStore.swift',
  'Sources/EgressViewAgentCore/OutboundCandidateTriage.swift',
  'Sources/EgressViewAgentUI/AgentDetailPopovers.swift',
  'Xcode/Host/AgentInsightPanel.swift',
  'Xcode/Host/AgentMainViewModel.swift',
  'Xcode/Host/ObservationWindowController.swift',
];

function swiftFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(full);
    return entry.name.endsWith('.swift') ? [full] : [];
  });
}

describe('候補への答えとメモは、このMacの画面の外へ出ない', () => {
  it('答えを読むのは、保存する場所と画面だけ', () => {
    const readers = ['Sources', 'Xcode']
      .flatMap(dir => swiftFiles(path.join(agentRoot, dir)))
      .filter(file => /Judgment|outbound_candidate_judgments/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(agentRoot, file).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(readers, [...allowed].sort());
  });

  it('画面に、答えとメモはHubやAIへ送らないと書く', () => {
    for (const language of ['en', 'ja']) {
      const strings = fs.readFileSync(
        path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
      );
      assert.match(strings, /^"Your answer and note stay on this Mac\. They are not sent to the Hub or an AI provider\." = /m);
    }
  });
});
