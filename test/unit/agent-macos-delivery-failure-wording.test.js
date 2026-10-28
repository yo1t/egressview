'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const { readAgentSource, agentRoot } = require('../helpers/agent-macos-sources.js');

const sender = readAgentSource('AgentIngestSender.swift');
const controller = readAgentSource('HubDeliveryController.swift');
const strings = language => fs.readFileSync(
  path.join(agentRoot, 'Xcode', 'Host', `${language}.lproj`, 'Localizable.strings'), 'utf8'
);

const keys = [
  'Pending observations could not be stored',
  'Hub rejected the pending batch (HTTP %lld)',
  'This Hub only accepts a newer format than this agent sends. Update the agent.',
  'This Hub only accepts an older format than this agent sends. Update the Hub.',
  // P3-148, 2026-10-29: refused for its times because this Mac's clock is off.
  "This Mac's clock is %@ ahead of the Hub's. Correct the date and time; sending resumes on its own.",
  "This Mac's clock is %@ behind the Hub's. Correct the date and time; sending resumes on its own.",
];

// On 2026-10-25 a Hub with no version in common stopped delivery, and the
// Japanese screen said why in English: the sender published a sentence and
// the app showed it without translating it (P3-7).
describe('Hubへの送信が止まった理由は、画面の言語で出る', () => {
  it('送信側は文ではなく理由の種類を渡す', () => {
    assert.match(sender, /case failed\(AgentIngestFailure\)/);
    assert.doesNotMatch(sender, /publish\(\.failed\("/);
  });

  it('画面側は理由をL()で言葉にする', () => {
    assert.match(controller, /case \.failed\(let failure\): return Self\.describe\(failure\)/);
    for (const key of keys) assert.ok(controller.includes(`L("${key}"`), key);
  });

  it('日英の両方に訳がある', () => {
    for (const language of ['en', 'ja']) {
      for (const key of keys) assert.ok(strings(language).includes(`"${key}" = `), `${language}: ${key}`);
    }
    assert.ok(strings('ja').includes('Agentを更新してください。'));
    assert.ok(strings('ja').includes('Hubを更新してください。'));
    assert.ok(strings('ja').includes('日付と時刻を直すと、送信は自動で再開します。'));
  });
});
