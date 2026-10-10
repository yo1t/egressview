'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const resources = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src', 'EgressView.Agent.Ui', 'Resources');
const japanese = fs.readFileSync(path.join(resources, 'Strings.ja.xaml'), 'utf8');

// P3-116: the Japanese screen still said "filter", "metadata", "preview",
// "cleanup", "tray" and more, in 35 strings, while the Mac said them in
// Japanese. These are the strings that keep English on purpose, and why.
const ENGLISH_ON_PURPOSE = {
  // Names of services and files, which are spelled as they are.
  EnrichmentPrivacySendsAddresses: 'ipwho.is',
  AskTheHubThenIpwho: 'ipwho.is',
  LookupThirdPartyNote: 'ipwho.is',
  SourceIpwho: 'ipwho.is',
  SourcePublicFeeds: 'abuse.ch',
  AbuseChTerms: 'abuse.ch',
  // A command to type.
  OllamaNoModels: 'ollama pull',
  // The field names the Hub receives, as the protocol spells them.
  HubExplanation: 'field names',
  // The manifest is the file's name in the release.
  UpdateInstallExplanation: 'manifest',
  // A command line and an Event Viewer path.
  DiagnosticsFallbackDetail: 'command line',
};

describe('Windows Agent Japanese wording', () => {
  it('no English word is left in the Japanese screen except those kept on purpose', () => {
    const offenders = [];
    for (const match of japanese.matchAll(/x:Key="([^"]+)">([\s\S]*?)<\/system:String>/g)) {
      const [, key, raw] = match;
      if (ENGLISH_ON_PURPOSE[key]) continue;
      const text = raw.replace(/\{[^}]*\}/g, '');
      const words = text.match(/(?<![A-Za-z0-9.-])[a-z][a-z]{3,}/g);
      if (words) offenders.push(`${key}: ${[...new Set(words)].join(', ')}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('every string kept in English on purpose still exists', () => {
    for (const key of Object.keys(ENGLISH_ON_PURPOSE)) assert.ok(japanese.includes(`x:Key="${key}"`), key);
  });
});
