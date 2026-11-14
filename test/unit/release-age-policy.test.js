'use strict';

// The release-age wait keeps a just-published (possibly hijacked) version out
// of the tree. ASH's semgrep rules for it expect 7 days and are suppressed in
// .ash/.ash.yaml because the wait is 2 days by decision (2026-11-14). This
// test is what still fails if the wait is shortened further or removed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const MIN_DAYS = 2;

const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
const dependabot = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');

function ecosystemBlocks(text) {
  // Each `updates` entry starts with "- package-ecosystem:"; the block runs
  // until the next one or the end of the file.
  const parts = text.split(/^\s*-\s+package-ecosystem:/m).slice(1);
  return parts.map((body) => {
    const name = body.match(/^\s*["']?([\w-]+)/)[1];
    return { name, body };
  });
}

describe('依存の公開待ち', () => {
  it('npmは公開から2日未満の版を選ばない', () => {
    const lines = npmrc.split('\n').filter((line) => /^\s*min-release-age\s*=/.test(line));
    assert.equal(lines.length, 1, '.npmrc must set min-release-age exactly once');
    const days = Number(lines[0].split('=')[1].trim());
    assert.ok(Number.isFinite(days) && days >= MIN_DAYS,
      `min-release-age is ${lines[0].trim()}, expected at least ${MIN_DAYS}`);
  });

  it('Dependabotはどの対象でも2日以上待ってから提案する', () => {
    const blocks = ecosystemBlocks(dependabot);
    assert.ok(blocks.length >= 2, 'expected the npm and github-actions entries');
    for (const { name, body } of blocks) {
      const match = body.match(/^\s*cooldown:\s*\n\s*default-days:\s*(\d+)/m);
      assert.ok(match, `${name} has no cooldown.default-days`);
      assert.ok(Number(match[1]) >= MIN_DAYS,
        `${name} cooldown is ${match[1]} days, expected at least ${MIN_DAYS}`);
    }
  });

  it('外した検査は2つの設定ファイルだけに効く', () => {
    const ash = fs.readFileSync(path.join(root, '.ash', '.ash.yaml'), 'utf8');
    for (const rule of [
      'npm-missing-minimum-release-age',
      'dependabot-missing-cooldown',
    ]) {
      const entries = ash.split(/^\s*-\s+path:/m).filter((entry) => entry.includes(rule));
      assert.equal(entries.length, 1, `${rule} should be suppressed exactly once`);
      assert.match(entries[0], /^\s*'(\.npmrc|\.github\/dependabot\.yml)'/);
    }
  });
});
