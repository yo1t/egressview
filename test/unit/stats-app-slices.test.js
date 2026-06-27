// Unit tests for _buildAppSlices() in public/js/utils.js
// Run: node --test test/unit/stats-app-slices.test.js

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

// Strip ES module import/export lines so the file can run in a VM classic-script context.
// export function/class/const/let/var declarations keep their body; only the 'export' keyword is removed.
function stripEsModule(src) {
  return src
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}
const src = stripEsModule(fs.readFileSync(
  path.join(__dirname, '../../public/js/utils.js'), 'utf8'
));

const ctx = vm.createContext({ window: { BASE_URL: '' }, t: key => key });
vm.runInContext(src, ctx);
const { _buildAppSlices: _buildRaw } = ctx;

// vm context creates Arrays in a different realm — deepStrictEqual rejects them.
// Serialize/deserialize to convert to host-realm plain objects.
const _buildAppSlices = (...args) => JSON.parse(JSON.stringify(_buildRaw(...args)));

const UNKNOWN = '不明';
const OTHER   = 'その他';

// helper: build a minimal conn object
const c = (dport, proto = 'TCP', dstHost = '') => ({ dport, proto, dst: dstHost, dstHost });

// ─── basic counting ─────────────────────────────────────────────────────────

describe('_buildAppSlices — basic counting', () => {
  it('empty conns returns []', () => {
    assert.deepEqual(_buildAppSlices([], 8, UNKNOWN, OTHER), []);
  });

  it('single TCP-443 conn → [["HTTPS", 1]]', () => {
    assert.deepEqual(_buildAppSlices([c(443, 'TCP')], 8, UNKNOWN, OTHER), [['HTTPS', 1]]);
  });

  it('three TCP-443 conns are grouped into one slice', () => {
    const conns = [c(443, 'TCP'), c(443, 'TCP'), c(443, 'TCP')];
    assert.deepEqual(_buildAppSlices(conns, 8, UNKNOWN, OTHER), [['HTTPS', 3]]);
  });

  it('mixed ports produce one slice each', () => {
    const conns = [c(443, 'TCP'), c(80, 'TCP'), c(22, 'TCP')];
    const slices = _buildAppSlices(conns, 8, UNKNOWN, OTHER);
    assert.equal(slices.length, 3);
    assert.ok(slices.some(([l]) => l === 'HTTPS'));
    assert.ok(slices.some(([l]) => l === 'HTTP'));
    assert.ok(slices.some(([l]) => l === 'SSH'));
  });

  it('unknown port is grouped under unknownLabel', () => {
    const slices = _buildAppSlices([c(59999)], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [[UNKNOWN, 1]]);
  });
});

// ─── UDP vs TCP disambiguation ──────────────────────────────────────────────

describe('_buildAppSlices — UDP vs TCP', () => {
  it('UDP-443 → QUIC, TCP-443 → HTTPS (separate slices)', () => {
    const conns = [c(443, 'UDP'), c(443, 'TCP')];
    const slices = _buildAppSlices(conns, 8, UNKNOWN, OTHER);
    assert.equal(slices.length, 2);
    assert.ok(slices.some(([l]) => l === 'QUIC'));
    assert.ok(slices.some(([l]) => l === 'HTTPS'));
  });

  it('UDP-123 → NTP', () => {
    const slices = _buildAppSlices([c(123, 'UDP')], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [['NTP', 1]]);
  });

  it('UDP-5353 → mDNS', () => {
    const slices = _buildAppSlices([c(5353, 'UDP')], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [['mDNS', 1]]);
  });

  it('UDP-51820 → WireGuard', () => {
    const slices = _buildAppSlices([c(51820, 'UDP')], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [['WireGuard', 1]]);
  });
});

// ─── hostname-based inference ────────────────────────────────────────────────

describe('_buildAppSlices — hostname matching', () => {
  it('TCP-443 to google.com → Google', () => {
    const slices = _buildAppSlices([c(443, 'TCP', 'www.google.com')], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [['Google', 1]]);
  });

  it('TCP-443 to amazonaws.com → AWS', () => {
    const slices = _buildAppSlices([c(443, 'TCP', 's3.amazonaws.com')], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [['AWS', 1]]);
  });

  it('UDP-443 to google.com is QUIC, not Google (UDP skips hostname matching)', () => {
    const slices = _buildAppSlices([c(443, 'UDP', 'www.google.com')], 8, UNKNOWN, OTHER);
    assert.deepEqual(slices, [['QUIC', 1]]);
  });
});

// ─── sorting ─────────────────────────────────────────────────────────────────

describe('_buildAppSlices — sort order', () => {
  it('highest count comes first', () => {
    const conns = [
      c(22, 'TCP'),                                         // SSH  ×1
      c(443, 'TCP'), c(443, 'TCP'), c(443, 'TCP'),          // HTTPS×3
      c(80, 'TCP'), c(80, 'TCP'),                           // HTTP ×2
    ];
    const slices = _buildAppSlices(conns, 8, UNKNOWN, OTHER);
    assert.equal(slices[0][0], 'HTTPS');
    assert.equal(slices[1][0], 'HTTP');
    assert.equal(slices[2][0], 'SSH');
  });
});

// ─── topN truncation and Other bucket ───────────────────────────────────────

describe('_buildAppSlices — topN / Other bucket', () => {
  it('exactly topN apps → no Other slice', () => {
    const ports = [22, 25, 53, 80, 110, 143, 443, 8080];
    const conns = ports.map(p => c(p, 'TCP'));
    const slices = _buildAppSlices(conns, 8, UNKNOWN, OTHER);
    assert.equal(slices.length, 8);
    assert.ok(slices.every(([l]) => l !== OTHER));
  });

  it('topN+1 apps → last slice is Other with correct count', () => {
    const ports = [22, 25, 53, 80, 110, 143, 443, 8080, 8443];
    const conns = ports.map(p => c(p, 'TCP'));
    // Add extra hits to 22 and 443 so they rank in top 8
    conns.push(c(22, 'TCP'), c(443, 'TCP'));
    const slices = _buildAppSlices(conns, 8, UNKNOWN, OTHER);
    assert.equal(slices.length, 9); // 8 + Other
    const last = slices[slices.length - 1];
    assert.equal(last[0], OTHER);
    assert.equal(last[1], 1); // only port 110 overflows with 1 hit
  });

  it('topN=1 puts everything except the top into Other', () => {
    const conns = [c(443, 'TCP'), c(443, 'TCP'), c(80, 'TCP'), c(22, 'TCP')];
    const slices = _buildAppSlices(conns, 1, UNKNOWN, OTHER);
    assert.equal(slices.length, 2);
    assert.equal(slices[0][0], 'HTTPS');
    assert.equal(slices[0][1], 2);
    assert.equal(slices[1][0], OTHER);
    assert.equal(slices[1][1], 2); // HTTP×1 + SSH×1
  });

  it('Other total equals sum of overflowing counts', () => {
    const conns = [
      ...Array(5).fill(null).map(() => c(443, 'TCP')),  // HTTPS ×5
      ...Array(3).fill(null).map(() => c(80,  'TCP')),  // HTTP  ×3
      c(22,  'TCP'),                                    // SSH   ×1
      c(25,  'TCP'),                                    // SMTP  ×1
    ];
    const slices = _buildAppSlices(conns, 2, UNKNOWN, OTHER);
    assert.equal(slices[0][0], 'HTTPS');  assert.equal(slices[0][1], 5);
    assert.equal(slices[1][0], 'HTTP');   assert.equal(slices[1][1], 3);
    assert.equal(slices[2][0], OTHER);    assert.equal(slices[2][1], 2);
  });
});
