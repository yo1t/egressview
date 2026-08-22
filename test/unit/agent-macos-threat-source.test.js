'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const controller = read('apps/agent-macos/Xcode/Host/ThreatIntelController.swift');
const downloader = read('apps/agent-macos/Sources/EgressViewAgentCore/ThreatFeedDownloader.swift');

// A Hub-enrolled agent may contact public feeds only after an explicit action
// or an explicit fallback opt-in plus a stale cache. These source checks pin
// that boundary without making network requests.
describe('macOS Agent threat intelligence source', () => {
  it('always picks the primary source from enrolment', () => {
    assert.match(controller, /ThreatIntelSource\.decide\(\s*isEnrolledWithHub:/);
  });

  it('tries the Hub before considering automatic fallback', () => {
    const hubBranch = controller.slice(
      controller.indexOf('case .hub:'),
      controller.indexOf('case .directDownload:')
    );
    assert.ok(hubBranch.length > 0, 'Hub branch not found');
    const hubFetch = hubBranch.indexOf('refreshFromHub');
    const fallbackPolicy = hubBranch.indexOf('ThreatIntelFallbackPolicy.shouldDownload');
    const feedFetch = hubBranch.indexOf('refreshFromFeeds');
    assert.ok(hubFetch >= 0);
    assert.ok(fallbackPolicy > hubFetch);
    assert.ok(feedFetch > fallbackPolicy);
  });

  it('gates fallback on persisted opt-in and cache age', () => {
    assert.match(controller, /isEnabled: preferences\.isHubFallbackEnabled/);
    assert.match(controller, /hasCachedIndicators: \(\(try\? store\.threatIndicatorCount\(\)\) \?\? 0\) > 0/);
    assert.match(controller, /lastSuccessfulFetch: preferences\.lastFetch/);
    assert.match(controller, /var isHubFallbackEnabled:/);
  });

  it('exposes one-time download as an explicit action', () => {
    const oneTime = controller.slice(
      controller.indexOf('func fetchDirectlyOnce()'),
      controller.indexOf('func refresh() async')
    );
    assert.match(oneTime, /await refreshFromFeeds/);
  });

  it('does not overlap scheduled and user-requested downloads', () => {
    assert.match(controller, /private var isRefreshing = false/);
    assert.ok((controller.match(/guard !isRefreshing else \{ return \}/g) || []).length >= 2);
  });

  it('sends no destination to the feed operators', () => {
    // Plain list downloads: a GET and nothing else. A query string or a body
    // would mean this Mac is telling someone what it connected to.
    assert.doesNotMatch(downloader, /httpBody/);
    assert.match(downloader, /request\.httpMethod = "GET"/);
    for (const feed of downloader.match(/URL\(string: "[^"]+"\)!/g) || []) {
      assert.doesNotMatch(feed, /\?/, `feed URL must carry no query: ${feed}`);
    }
  });

  it('forces a full Hub refresh after public-feed fallback', () => {
    const directFetch = controller.slice(controller.indexOf('private func refreshFromFeeds'));
    assert.match(directFetch, /preferences\.etag = nil/);
  });
});
