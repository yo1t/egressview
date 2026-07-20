'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '../../src');

function javascriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.name.endsWith('.js') ? [target] : [];
  });
}

describe('domain-owned limits', () => {
  it('does not reintroduce an unexplained bare 8000 literal in source modules', () => {
    const offenders = javascriptFiles(SRC_DIR)
      .filter(file => /\b8000\b/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC_DIR, file));
    assert.deepEqual(offenders, []);
  });
});
