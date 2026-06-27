'use strict';

// Unit tests for the pure formatting / classification helpers in public/js/utils.js
// (esc, fmtBytes, fmtTs, nodeColor, nodeClass, typeLabel, isWiredType).
// utils.js has no top-level DOM side-effects, so the whole file evaluates in a vm
// context with window + a t() i18n stub (same approach as stats-app-slices.test.js).
// Run: node --test test/unit/utils-format.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Strip ES module import/export lines so the file can run in a VM classic-script context.
// export function/class/const/let/var declarations keep their body; only the 'export' keyword is removed.
function stripEsModule(src) {
  return src
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}
const src = stripEsModule(fs.readFileSync(path.join(__dirname, '../../public/js/utils.js'), 'utf8'));
// t() is only invoked at call time (inside typeLabel), so an identity stub is enough.
const ctx = vm.createContext({ window: { BASE_URL: '' }, t: key => key });
vm.runInContext(src, ctx);
const { esc, fmtBytes, fmtTs, nodeColor, nodeClass, typeLabel, isWiredType } = ctx;

describe('esc', () => {
  it('escapes all five HTML metacharacters', () => {
    assert.equal(esc(`<a href="x" data='y'>&</a>`),
      '&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  it('returns empty string for null / undefined', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });
  it('stringifies non-string input', () => {
    assert.equal(esc(42), '42');
    assert.equal(esc(0), '0');
  });
  it('leaves a safe string untouched', () => {
    assert.equal(esc('plain text 123'), 'plain text 123');
  });
});

describe('fmtBytes', () => {
  it('returns 0 B/s for falsy or NaN', () => {
    assert.equal(fmtBytes(0), '0 B/s');
    assert.equal(fmtBytes(NaN), '0 B/s');
    assert.equal(fmtBytes(undefined), '0 B/s');
  });
  it('keeps small values in B/s', () => {
    assert.equal(fmtBytes(512), '512 B/s');
  });
  it('uses one decimal below 10, none at/above 10', () => {
    assert.equal(fmtBytes(1536), '1.5 KB/s');   // 1.5 < 10 → 1 decimal
    assert.equal(fmtBytes(15360), '15 KB/s');   // 15 >= 10 → 0 decimals
  });
  it('scales up to MB/s and GB/s', () => {
    assert.equal(fmtBytes(1048576), '1.0 MB/s');
    assert.equal(fmtBytes(1073741824), '1.0 GB/s');
  });
  it('caps the unit at GB/s', () => {
    assert.match(fmtBytes(1024 * 1024 * 1024 * 1024), /GB\/s$/);
  });
});

describe('fmtTs', () => {
  it('returns em-dash for falsy timestamp', () => {
    assert.equal(fmtTs(0), '—');
    assert.equal(fmtTs(null), '—');
  });
  it('renders a non-empty date/time string for a real timestamp', () => {
    const out = fmtTs(Date.UTC(2026, 0, 2, 3, 4));
    assert.notEqual(out, '—');
    assert.match(out, /\d{2}:\d{2}$/);   // ends with HH:MM
  });
});

describe('nodeColor', () => {
  it('maps connection types to colors', () => {
    assert.equal(nodeColor('0'), '#ef4444');   // wired
    assert.equal(nodeColor('1'), '#10b981');   // 2.4GHz
    assert.equal(nodeColor('2'), '#8b5cf6');   // 5GHz
    assert.equal(nodeColor('3'), '#eab308');   // 6GHz
  });
  it('returns gray for unknown type', () => {
    assert.equal(nodeColor('9'), '#6b7280');
    assert.equal(nodeColor(undefined), '#6b7280');
  });
});

describe('nodeClass', () => {
  it('maps types to CSS classes', () => {
    assert.equal(nodeClass('0'), 'wired');
    assert.equal(nodeClass('1'), 'wifi-2g');
    assert.equal(nodeClass('2'), 'wifi-5g');
    assert.equal(nodeClass('3'), 'wifi-6g');
  });
  it('defaults unknown type to wired', () => {
    assert.equal(nodeClass('9'), 'wired');
  });
});

describe('typeLabel', () => {
  it('returns the i18n key per type (identity stub)', () => {
    assert.equal(typeLabel('0'), 'type.wired');
    assert.equal(typeLabel('1'), 'type.wifi24');
    assert.equal(typeLabel('2'), 'type.wifi5');
    assert.equal(typeLabel('3'), 'type.wifi6');
    assert.equal(typeLabel('9'), 'type.unknown');
  });
});

describe('isWiredType', () => {
  it('is true only for type "0"', () => {
    assert.equal(isWiredType('0'), true);
    assert.equal(isWiredType('1'), false);
    assert.equal(isWiredType(undefined), false);
  });
});
