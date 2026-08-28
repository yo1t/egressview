'use strict';

// Replays every input the long fuzz run found (P2-96).
//
// This is the path the continuous run needs to be worth having: a crash found
// at 3am is written into `corpus/`, committed, and checked here for good.
// Without it, the long run produces log lines that nobody reads twice.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TARGETS } = require('./targets');
const { safeName } = require('../../scripts/fuzz-continuous');

const CORPUS_DIR = path.join(__dirname, 'corpus');
const BUDGET_MS = 250;

function corpusDirectories() {
  if (!fs.existsSync(CORPUS_DIR)) return [];
  return fs.readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function corpusFiles(directory) {
  return fs.readdirSync(path.join(CORPUS_DIR, directory))
    .filter(name => !name.startsWith('.'))
    .map(name => path.join(CORPUS_DIR, directory, name));
}

const targetsByDirectory = new Map(TARGETS.map(entry => [safeName(entry[0]), entry]));

describe('fuzzが見つけた入力の回帰 (P2-96)', () => {
  it('corpusのディレクトリ名が、いまも存在する対象を指している', () => {
    // A renamed parser would leave its regressions in a directory nothing
    // replays. They would still be committed, still look like coverage, and
    // never run again.
    const orphans = corpusDirectories().filter(name => !targetsByDirectory.has(name));
    assert.deepEqual(orphans, [],
      `corpus directories with no matching target in targets.js: ${orphans.join(', ')}`);
  });

  for (const directory of corpusDirectories()) {
    const entry = targetsByDirectory.get(directory);
    if (!entry) continue;
    const [name, call, shapeOk] = entry;
    for (const file of corpusFiles(directory)) {
      it(`${name}: ${path.basename(file)}`, () => {
        const input = fs.readFileSync(file, 'utf8');
        const startedAt = process.hrtime.bigint();
        const result = call(input);
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        assert.ok(shapeOk(result),
          `unexpected shape: ${Object.prototype.toString.call(result)}`);
        assert.ok(elapsedMs <= BUDGET_MS,
          `took ${elapsedMs.toFixed(1)}ms, budget ${BUDGET_MS}ms`);
      });
    }
  }

  it('corpusの件数を報告する', () => {
    // An empty corpus passes every test above by having nothing to run, which
    // looks exactly like a corpus that is being checked. Print the count so
    // the difference is visible, and assert only what is true: the directory
    // exists and is readable, so a finding has somewhere to land.
    const total = corpusDirectories().reduce((sum, dir) => sum + corpusFiles(dir).length, 0);
    assert.ok(fs.existsSync(CORPUS_DIR), 'corpus directory is missing; findings would have nowhere to go');
    process.stdout.write(`# fuzz corpus entries: ${total}\n`);
  });
});
