'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const store = read('apps/agent-macos/Sources/EgressViewAgentCore/ObservationStore.swift');
const atlas = read('apps/agent-macos/Sources/EgressViewAgentCore/WorldAtlas.swift');
const globe = read('apps/agent-macos/Xcode/Host/ObservationWindowController.swift');

describe('macOS Agent all-time country history', () => {
  it('uses a bounded country summary and keeps unresolved addresses separate', () => {
    assert.match(store, /CREATE TABLE IF NOT EXISTS country_visit_summary/);
    assert.match(store, /country_code TEXT PRIMARY KEY/);
    assert.match(store, /CREATE TABLE IF NOT EXISTS pending_destination_country/);
    assert.match(store, /OFFSET 50000/);
    assert.match(store, /90 \* 86_400/);
  });

  it('does not update an existing country for every observation', () => {
    assert.match(store, /countrySummaryFlushInterval: TimeInterval = 60/);
    assert.match(store, /pendingCountryUpdates/);
    assert.match(store, /if !knownVisitedCountries\.contains\(code\)/);
    assert.match(store, /flushCountryVisitSummary/);
  });

  it('resolves locations in batches and backfills after a geo refresh', () => {
    assert.match(store, /for start in stride\(from: 0, to: missing\.count, by: 400\)/);
    assert.match(store, /resolvePendingCountriesLocked/);
    assert.match(store, /backfillCountryVisitsFromRetainedHistory/);
  });

  it('deletes the all-time memory with local connection history', () => {
    const removeAll = store.slice(store.indexOf('public func removeAll()'));
    assert.match(removeAll, /DELETE FROM country_visit_summary/);
    assert.match(removeAll, /DELETE FROM pending_destination_country/);
  });

  it('keeps country identity in the atlas and shades visited countries', () => {
    assert.match(atlas, /public struct Country: Sendable/);
    assert.match(atlas, /public let code: String\?/);
    assert.match(globe, /model\.visitedCountryCodes\.contains/);
    assert.match(globe, /systemTeal\.withAlphaComponent\(0\.26\)/);
  });

  it('switches from the globe to a local all-time destination-country list', () => {
    assert.match(globe, /case destinations/);
    assert.match(globe, /L\("Destination countries"\)/);
    assert.match(globe, /countryView = \.destinations/);
    assert.match(globe, /AgentCountryHistoryList\(rows: model\.countryHistory\)/);
    assert.match(globe, /LazyVStack/);
    assert.match(globe, /L\("First accessed"\)/);
    assert.match(globe, /L\("Last accessed"\)/);
    assert.match(globe, /row\.lastProcessName/);
    assert.match(globe, /row\.connectionCount/);
  });
});
