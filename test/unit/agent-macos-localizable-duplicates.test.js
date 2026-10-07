'use strict';

// A .strings file with the same key twice uses the later value and says
// nothing, so the earlier translation silently never shows. "Data volume"
// was in the Japanese file as both データ量 and データ転送量, and
// "Connections" as both 接続 and 接続数; nobody could tell from the file which
// one the app displayed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'apps', 'agent-macos', 'Xcode', 'Host');

for (const language of ['en', 'ja']) {
  test(`${language}.lproj/Localizable.strings に同じキーが二度ない`, () => {
    const text = fs.readFileSync(path.join(root, `${language}.lproj`, 'Localizable.strings'), 'utf8');
    const seen = new Map();
    const duplicates = [];
    text.split('\n').forEach((line, index) => {
      const match = line.match(/^"((?:[^"\\]|\\.)*)"\s*=/);
      if (!match) return;
      if (seen.has(match[1])) duplicates.push(`${match[1]} (lines ${seen.get(match[1])} and ${index + 1})`);
      else seen.set(match[1], index + 1);
    });
    assert.deepEqual(duplicates, []);
  });
}
