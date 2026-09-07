'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// P3-55. "Offline" alone made a user check five separate things to find out
// why, and the answer was a twenty-five minute idle sleep. Twenty-five minutes
// and three days used to read identically.
const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'public/js/display-scope.js'), 'utf8');

function loadElapsedLabel(lang) {
  const strings = JSON.parse(
    fs.readFileSync(path.join(root, 'src/data/i18n.json'), 'utf8')
  )[lang];
  // Take the one function, not the rest of the module: everything after it is
  // DOM and storage the rule does not need.
  const start = source.indexOf('function elapsedLabel');
  const end = source.indexOf('\nfunction ', start);
  const body = source
    .slice(start, end > 0 ? end : undefined)
    ;
  const ctx = {
    exports: {},
    Number, Math,
    t: (key) => strings[key] ?? key,
    tVars: (key, vars) => String(strings[key] ?? key)
      .replace(/\{(\w+)\}/g, (_, name) => String(vars[name])),
  };
  vm.runInNewContext(`${body}\nexports.elapsedLabel = elapsedLabel;`, ctx);
  return ctx.exports.elapsedLabel;
}

describe('オフラインに、いつからかを添える（P3-55）', () => {
  const now = Date.UTC(2026, 8, 7, 12, 0, 0);

  it('25分と3日を区別する', () => {
    // The two readings that used to be the same two characters.
    const elapsed = loadElapsedLabel('ja');
    assert.equal(elapsed(now - 25 * 60_000, now), '25分前');
    assert.equal(elapsed(now - 3 * 86_400_000, now), '3日前');
    assert.notEqual(elapsed(now - 25 * 60_000, now), elapsed(now - 3 * 86_400_000, now));
  });

  it('分・時間・日で単位が切り替わる', () => {
    const elapsed = loadElapsedLabel('ja');
    assert.equal(elapsed(now - 59 * 60_000, now), '59分前');
    assert.equal(elapsed(now - 60 * 60_000, now), '1時間前');
    assert.equal(elapsed(now - 23 * 3_600_000, now), '23時間前');
    assert.equal(elapsed(now - 24 * 3_600_000, now), '1日前');
  });

  it('直後でも0分前とは言わない', () => {
    // "0 minutes ago" alongside "Offline" contradicts itself.
    const elapsed = loadElapsedLabel('ja');
    assert.equal(elapsed(now - 5_000, now), '1分前');
  });

  it('一度も受信していない場合を経過時間と混ぜない', () => {
    // A Mac that has never reported is not one that reported long ago.
    const elapsed = loadElapsedLabel('ja');
    assert.equal(elapsed(0, now), '受信なし');
    assert.equal(elapsed(null, now), '受信なし');
  });

  it('英語でも切り替わる', () => {
    const elapsed = loadElapsedLabel('en');
    assert.equal(elapsed(now - 25 * 60_000, now), '25 min ago');
    assert.equal(elapsed(now - 3 * 86_400_000, now), '3 d ago');
    assert.equal(elapsed(0, now), 'never seen');
  });

  it('オンラインの表示は変えていない', () => {
    // Nobody was confused by it, and changing it would be scope the spec
    // explicitly declined.
    assert.match(source, /t\('source\.online'\)/);
    assert.doesNotMatch(source, /source\.online\.since/);
  });
});
