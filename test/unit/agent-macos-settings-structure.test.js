'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(
  path.join(root, 'apps/agent-macos/Xcode/Host/HubDeliveryController.swift'),
  'utf8'
);

function section(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

describe('macOS Agent settings structure', () => {
  it('provides a dedicated Notifications destination', () => {
    assert.match(source, /case notifications/);
    assert.match(source, /case \.notifications: return L\("Notifications"\)/);
    assert.match(source, /case \.notifications: notificationSettings/);
  });

  it('診断タブから診断ファイルを保存できる', () => {
    // Asked for on 2026-08-23: the menu is the only entry point, and settings
    // has room to say what is in the file before someone sends it. Both are
    // kept -- this window is one of the things that can fail to open, which is
    // exactly when the file is wanted.
    assert.match(source, /settingsGroup\(L\("Diagnostics file"\)\)/);
    assert.match(source, /Button\(L\("Save diagnostics\.\.\."\)\) \{ model\.saveDiagnostics\(\) \}/);
    assert.match(source, /no destination address, process name or host name/);
    assert.match(source, /Also available from the menu bar/);
  });

  it('provides a dedicated Data Enrichment destination', () => {
    assert.match(source, /case enrichment/);
    assert.match(source, /case \.enrichment: return L\("Data Enrichment"\)/);
    assert.match(source, /case \.enrichment: enrichmentSettings/);
  });

  it('provides a dedicated AI destination for Ollama configuration', () => {
    assert.match(source, /case ai/);
    assert.match(source, /case \.ai: return L\("AI"\)/);
    assert.match(source, /case \.ai: aiSettings/);
    const ai = section('private var aiSettings:', '@ViewBuilder\n    private var geoSection:');
    assert.match(ai, /ollama\.setEndpoint/);
    assert.match(ai, /ollama\.selectModel/);
    assert.match(ai, /ollama\.saveAndTest\(\)/);
  });

  it('keeps Hub settings limited to enrollment and delivery', () => {
    const hub = section('private var hubSettings:', 'private var enrichmentSettings:');
    assert.match(hub, /settingsGroup\(L\("Enrollment"\)\)/);
    assert.match(hub, /settingsGroup\(L\("Delivery"\)\)/);
    assert.doesNotMatch(hub, /geoSection|serverNameSection|threatSection/);
  });

  it('places local destination-name inspection in General', () => {
    const general = section('private var general:', 'private var hubSettings:');
    assert.match(general, /serverNameSection/);
    const destinationNames = section('private var serverNameSection:', 'private var diagnosticsSettings:');
    assert.doesNotMatch(destinationNames, /quicDiagnostics|Refresh QUIC check counters/);
  });

  it('groups location and threat context under Data Enrichment', () => {
    const enrichment = section('private var enrichmentSettings:', 'private var geoSection:');
    assert.match(enrichment, /geoSection/);
    assert.match(enrichment, /threatSection/);
    assert.doesNotMatch(enrichment, /serverNameSection/);
  });

  it('offers explicit Hub fallback controls with feed disclosure', () => {
    const threats = section('private var threatSection:', 'private var threatFeedTerms:');
    assert.match(threats, /Fetch once from public feeds/);
    assert.match(threats, /isHubFallbackEnabled/);
    assert.match(threats, /at least 24 hours old/);
    assert.match(threats, /feed operators can see that this Mac connected/);
  });

  it('keeps QUIC counters in a dedicated diagnostics screen', () => {
    assert.match(source, /case diagnostics/);
    assert.match(source, /case \.diagnostics: diagnosticsSettings/);
    const diagnostics = section('private var diagnosticsSettings:', 'private var threatSection:');
    assert.match(diagnostics, /model\.quicDiagnostics/);
    assert.match(diagnostics, /Refresh QUIC check counters/);
    assert.match(diagnostics, /if model\.readsServerName/);
  });
});
