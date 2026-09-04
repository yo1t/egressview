'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const enrichment = require('../../src/enrichment');

// Measured on production 2026-09-04: srcDnsName held
// "ip-<a>-<b>-<c>-<d>.<region>.compute.internal" for 200k+ rows whose src was
// the plain private address. AWS's resolver answers that shape for any private
// address it is asked about, so the name restated the address and nothing
// more -- while the destination column, which already applied this test,
// showed the address itself. The two columns disagreed because the rule lived
// in one of them.
test('a PTR that only restates the address is rejected', () => {
  for (const host of [
    'ip-192-168-41-33.ap-northeast-1.compute.internal',
    'ip-10-41-128-183.ap-northeast-1.compute.internal',
    'ec2-1-2-3-4.compute-1.amazonaws.com',
    '1-2-3-4.example.net',
  ]) {
    assert.equal(enrichment.isPtrJunk(host), true, `${host} should be rejected`);
  }
});

// Starting with "ip-" is not by itself a reason to drop a name: ip-api.com is a
// real service, and an ISP's ip-<x>-<y>-<z>.<domain> carries the ISP.
test('a real name that happens to start with ip- is kept', () => {
  for (const host of ['ip-api.com', 'ip-253-24-69.axgn.com', 'host.example.com']) {
    assert.equal(enrichment.isPtrJunk(host), false, `${host} should be kept`);
  }
});

// The rule is only worth having if every path that stores a PTR applies it.
// The source side stored names without it until 2026-09-04.
test('every module that stores a reverse-DNS name applies the same test', () => {
  const files = [
    'src/device-identify.js',
    'src/runtime.js',
    'src/enrichment-queue.js',
  ];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!/dns\.reverse\(|reverseDns\(|dnsCached|dc2/.test(src)) continue;
    assert.match(
      src,
      /isPtrJunk/,
      `${file} stores a reverse-DNS name without applying isPtrJunk`
    );
  }
});

test('the source probe and the node-meta refresh both filter', () => {
  const src = readFileSync('src/device-identify.js', 'utf8');
  const refresh = src.match(/async function refreshNodeMeta[\s\S]*?\n\}/);
  assert.ok(refresh, 'refreshNodeMeta not found');
  assert.match(refresh[0], /isPtrJunk/, 'refreshNodeMeta stores an unfiltered PTR');

  // Both call sites filter, but not at the same distance: one filters inline,
  // the other a few lines below where the result is assigned. The window has to
  // cover the assignment, not just the call.
  const reverseCalls = [...src.matchAll(/dns\.reverse\(ip\)[\s\S]{0,300}/g)].map(m => m[0]);
  assert.ok(reverseCalls.length >= 2, 'expected both reverse-DNS call sites');
  for (const call of reverseCalls) {
    assert.match(call, /isPtrJunk/, `an unfiltered dns.reverse remains: ${call.slice(0, 60)}`);
  }
});
