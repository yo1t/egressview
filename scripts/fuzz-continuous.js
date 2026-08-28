#!/usr/bin/env node
'use strict';

/**
 * Fuzz the parsers for a wall-clock budget rather than a fixed iteration count
 * (P2-96).
 *
 * The PR gate runs 300 iterations on one seed, because a gate that takes an
 * hour is a gate people route around. That is "a little, every time" -- it is
 * not continuous fuzzing, and inputs that need a long search are exactly the
 * ones it cannot reach.
 *
 * This runs until a deadline, over many seeds, and writes the failing inputs
 * into `test/fuzz/corpus/`. That directory is replayed by
 * `test/fuzz/corpus.test.js`, which `npm test` runs, so an input found at 3am
 * becomes a permanent regression test rather than a line in a log nobody reads
 * twice. The replay is deterministic; the campaign here is not, which is why
 * only the replay belongs in `npm test`.
 *
 * **What this is not.** There is no coverage feedback and no corpus-guided
 * mutation, so it does not learn which inputs reach new code the way OSS-Fuzz
 * does. It searches more of the same space, for longer, from seeds it has not
 * used before. That is a real difference and it is why the completion criteria
 * for P2-96 talk about running past the CI budget, not about matching
 * OSS-Fuzz.
 *
 * Usage:
 *   node scripts/fuzz-continuous.js [--minutes 20] [--seed 12345]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { forEachInput, describeFailure } = require('../test/fuzz/fuzz-lib');
const { TARGETS } = require('../test/fuzz/targets');

const CORPUS_DIR = path.join(__dirname, '..', 'test', 'fuzz', 'corpus');
// Small enough that one pass over every target is quick, so the deadline is
// checked often and a long run is many seeds rather than one enormous batch.
const ITERATIONS_PER_ROUND = 200;
// How many new files one target may add in one run.
//
// A real defect fires on thousands of inputs, not one. Measured 2026-08-29
// with a deliberately broken parser: three seconds produced 4,639 distinct
// failing inputs. Saving them all is not a regression corpus, it is a dump
// nobody will read, and it buries the second defect under the first.
const MAX_NEW_PER_TARGET = 5;

function parseArgs(argv) {
  const options = { minutes: 20, seed: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--minutes') options.minutes = Number(argv[++i]);
    else if (argv[i] === '--seed') options.seed = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(options.minutes) || options.minutes <= 0) {
    throw new Error('--minutes must be a positive number');
  }
  return options;
}

function safeName(target) {
  return target.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Save a failing input so the ordinary test run keeps checking it.
 *
 * Named by a hash of the input, so the same finding twice is one file rather
 * than a directory that grows every night.
 */
function saveToCorpus(target, failure) {
  const dir = path.join(CORPUS_DIR, safeName(target));
  fs.mkdirSync(dir, { recursive: true });
  const digest = crypto.createHash('sha256').update(failure.input).digest('hex').slice(0, 16);
  const file = path.join(dir, `${failure.kind}-${digest}.txt`);
  if (fs.existsSync(file)) return null;
  fs.writeFileSync(file, failure.input);
  return file;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.minutes * 60_000;
  // A seed per run, printed, so any finding can be reproduced exactly.
  let seed = options.seed ?? crypto.randomInt(2 ** 31);
  const startedSeed = seed;

  let totalFindings = 0;
  let rounds = 0;
  let inputs = 0;
  const added = [];
  const reported = [];
  const savedPerTarget = new Map();
  let suppressed = 0;

  process.stdout.write(
    `Fuzzing ${TARGETS.length} parsers for ${options.minutes} minute(s), first seed ${startedSeed}\n`
  );

  while (Date.now() < deadline) {
    for (const [name, call, shapeOk, samples] of TARGETS) {
      const failures = forEachInput(
        { samples, iterations: ITERATIONS_PER_ROUND, seed },
        (input) => {
          const result = call(input);
          if (!shapeOk(result)) {
            throw new Error(`unexpected shape: ${Object.prototype.toString.call(result)}`);
          }
        }
      );
      inputs += ITERATIONS_PER_ROUND;
      for (const failure of failures) {
        const alreadySaved = savedPerTarget.get(name) || 0;
        if (alreadySaved < MAX_NEW_PER_TARGET) {
          const file = saveToCorpus(name, failure);
          if (file) {
            added.push(path.relative(path.join(__dirname, '..'), file));
            savedPerTarget.set(name, alreadySaved + 1);
          }
        } else {
          suppressed += 1;
        }
        // Every finding is counted even when its input is not saved, so the
        // report says how big the problem is rather than how many files fit.
        if (reported.length < 40) {
          reported.push(`${name} (seed ${seed}): ${describeFailure(failure)}`);
        }
        totalFindings += 1;
      }
      if (Date.now() >= deadline) break;
    }
    rounds += 1;
    seed = (seed + 1) >>> 0;
  }

  process.stdout.write(`Rounds: ${rounds}\n`);
  process.stdout.write(`Inputs: ${inputs}\n`);
  process.stdout.write(`Seeds:  ${startedSeed}..${seed}\n`);
  process.stdout.write(`Findings: ${totalFindings}\n`);
  process.stdout.write(`New corpus entries: ${added.length}`
    + (suppressed ? ` (${suppressed} further inputs hit the same parsers and were not saved)` : '')
    + '\n');

  for (const line of reported) process.stderr.write(`\n${line}\n`);
  if (totalFindings > reported.length) {
    process.stderr.write(`\n...and ${totalFindings - reported.length} more findings\n`);
  }
  for (const file of added) process.stderr.write(`saved ${file}\n`);

  if (totalFindings) {
    process.stderr.write(
      '\nEach failing input was written to test/fuzz/corpus/. Commit those files:\n'
      + 'corpus.test.js replays them on every run, so the fix stays fixed.\n'
    );
    process.exit(1);
  }
  // Zero findings is the normal result. Saying so, with the counts above, is
  // the difference between "nothing was wrong" and "nothing ran".
  process.stdout.write('No findings.\n');
}

if (require.main === module) main();

module.exports = { parseArgs, safeName };
