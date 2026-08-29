'use strict';

// A feed that did not answer must be visible (P3-54).
//
// On 2026-08-29 the Hub matched with Feodo's C2 list entirely absent --
// abuse.ch was serving 503 from an expired certificate -- and the startup line
// still read `Ready: 6995 IPs`, because the other three feeds are large. The
// indicators live in memory only, so a process that starts while a feed is
// down starts without it and stays that way.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const threatIntel = require('../../src/threat-intel');

const ok = (data) => ({ status: 'fulfilled', value: { data } });
const failed = (message) => ({ status: 'rejected', reason: new Error(message) });

// Feed order: feodo, threatfox, urlhaus, spamhaus.
// first_seen_utc, dst_ip, dst_port, ... -- the address is the second field.
const FEODO = '2026-01-01 00:00:00,198.51.100.9,443,2026-01-02,online\n';
const SPAMHAUS = '203.0.113.0/24 ; SBL0000\n';

function apply(results) {
  threatIntel._applyFeedResults(results);
  return threatIntel.getStats();
}

describe('脅威フィードの鮮度をソースごとに言う (P3-54)', () => {
  beforeEach(() => {
    apply([ok(FEODO), ok(''), ok(''), ok(SPAMHAUS)]);
  });

  it('全ソースが答えれば、欠けているものは無い', () => {
    const stats = apply([ok(FEODO), ok(''), ok(''), ok(SPAMHAUS)]);
    assert.equal(stats.feeds.length, 4);
    assert.deepEqual(stats.feeds.filter(f => f.lastError).map(f => f.name), []);
    assert.deepEqual(stats.feeds.filter(f => f.contributingNothing).map(f => f.name), []);
  });

  it('失敗したソースは名前・理由・最終成功時刻を持つ', () => {
    const stats = apply([failed('Request failed with status code 503'), ok(''), ok(''), ok(SPAMHAUS)]);
    const feodo = stats.feeds.find(f => f.name === 'feodo');
    assert.match(feodo.lastError, /503/);
    assert.ok(feodo.lastSuccessAt, 'a feed that succeeded earlier keeps its success time');
    // Its entries are retained and still matched against, so the count is not
    // zeroed. Reporting 0 would under-report what matching actually uses.
    assert.ok(feodo.entries > 0);
    assert.equal(feodo.contributingNothing, false);
  });

  it('一度も成功していないソースは、古いのではなく「何も出していない」', () => {
    // The state after a restart while the feed is down -- which is what
    // happened in production, twice, on 2026-08-29. It is a different fact
    // from "the entries are old" and has to read differently.
    const fresh = require('node:module');
    delete require.cache[require.resolve('../../src/threat-intel')];
    const isolated = require('../../src/threat-intel');
    isolated._applyFeedResults([
      failed('Request failed with status code 503'), ok(''), ok(''), ok(SPAMHAUS),
    ]);
    const feodo = isolated.getStats().feeds.find(f => f.name === 'feodo');
    assert.equal(feodo.lastSuccessAt, null);
    assert.equal(feodo.entries, 0);
    assert.equal(feodo.contributingNothing, true);
    assert.ok(fresh);
  });

  it('合計だけでは欠落が見えない、ということを示す', () => {
    // The whole point. The totals stay large because the other feeds are
    // large, so a healthy-looking number is exactly what a missing feed
    // produces.
    delete require.cache[require.resolve('../../src/threat-intel')];
    const isolated = require('../../src/threat-intel');
    const urlhausRow = ',,https://bad.example/x.bin,online\n';
    const stats = isolated._applyFeedResults([
      failed('503'), ok(''), ok(`#\n${urlhausRow.repeat(50)}`), ok(SPAMHAUS),
    ]) || isolated.getStats();

    assert.ok(stats.domains + stats.ips + stats.cidrs > 0,
      'totals look populated even though a feed is missing');
    assert.equal(stats.feeds.find(f => f.name === 'feodo').contributingNothing, true);
  });
});

describe('GET /api/status がフィードの状態を返す (P3-54)', () => {
  const configRoutes = require('../../src/routes/config');

  function statusHandlerFor(ctx) {
    // The router is mounted at /api, so this route is `GET /api/status`.
    // Verified against the running Hub: /api/status answers 401 (auth
    // required, route present) while /api/config/status is 404. The comment
    // in config.js said the latter until 2026-08-29.
    //
    // Reached through the router's own stack rather than a stand-in, so a
    // route that was never registered fails here rather than passing.
    const router = configRoutes(ctx);
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/status' && l.route.methods.get
    );
    assert.ok(layer, 'GET /status is not registered');
    return layer.route.stack[layer.route.stack.length - 1].handle;
  }

  const baseCtx = () => ({
    requireAdmin: (req, res, next) => next(),
    asus: { isAuthenticated: () => false, getRouterIp: () => null },
    enrichment: { getApiStats: () => ({}), getDnsCache: () => new Map() },
    notifier: {}, history: {},
    dnsmasqLog: { stop() {}, configure() {} },
    inspectSyslog: { stop() {}, configure() {} },
    dhcpdSyslog: { stop() {}, configure() {} },
    runtime: {}, appState: {}, saveConfig() {},
  });

  it('ソース別の状態が応答に含まれる', () => {
    const stats = { ips: 1, domains: 0, cidrs: 0, lastFetch: 1, feeds: [
      { name: 'feodo', entries: 0, lastSuccessAt: null, lastAttemptAt: 1, lastError: '503', contributingNothing: true },
    ] };
    const handler = statusHandlerFor({ ...baseCtx(), threatIntel: { getStats: () => stats } });
    let body = null;
    handler({ query: {} }, { json: (value) => { body = value; } });
    assert.deepEqual(body.threatIntel.feeds[0].name, 'feodo');
    assert.equal(body.threatIntel.feeds[0].contributingNothing, true);
  });

  it('脅威情報を持たないHubでも応答する', () => {
    // A Hub can legitimately run with no feeds. The status route must not be
    // the thing that breaks in that configuration.
    const handler = statusHandlerFor({ ...baseCtx(), threatIntel: null });
    let body = null;
    handler({ query: {} }, { json: (value) => { body = value; } });
    assert.equal(body.threatIntel, null);
  });
});

