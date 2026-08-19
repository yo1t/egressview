'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const controller = read('apps/agent-macos/Xcode/Host/ThreatIntelController.swift');
const downloader = read('apps/agent-macos/Sources/EgressViewAgentCore/ThreatFeedDownloader.swift');

// The property being protected: a Hub-enrolled agent never contacts a third
// party for threat data, however unreachable its Hub is. The rule itself is
// unit tested in ThreatIntelSourceTests; these check it is the rule actually
// used, because a correct rule nobody calls protects nothing.
describe('macOS Agent threat intelligence source', () => {
  it('picks the source from enrolment, not reachability', () => {
    assert.match(controller, /ThreatIntelSource\.decide\(\s*isEnrolledWithHub:/);
    assert.doesNotMatch(controller, /isReachable|reachability|isHubReachable/);
  });

  it('never downloads feeds from the Hub branch', () => {
    const hubBranch = controller.slice(
      controller.indexOf('case .hub:'),
      controller.indexOf('case .directDownload:')
    );
    assert.ok(hubBranch.length > 0, 'Hub branch not found');
    assert.doesNotMatch(hubBranch, /refreshFromFeeds/);
  });

  it('never downloads feeds when a Hub fetch fails', () => {
    const hubFetch = controller.slice(
      controller.indexOf('private func refreshFromHub'),
      controller.indexOf('private func refreshFromFeeds')
    );
    assert.ok(hubFetch.length > 0, 'refreshFromHub not found');
    assert.doesNotMatch(hubFetch, /refreshFromFeeds/);
  });

  it('reaches the third-party feeds from exactly one place', () => {
    const calls = controller.match(/await refreshFromFeeds\(/g) || [];
    assert.equal(calls.length, 1);
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
});
