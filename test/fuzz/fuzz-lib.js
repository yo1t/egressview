// Minimal seeded input generator for parser fuzzing (P2-71).
//
// Deliberately dependency-free. A property-based library would be a new
// supply-chain edge for a project that runs 13 production dependencies, and
// what is needed here is small: reproducible pseudo-random bytes, mutations of
// realistic lines, and a set of shapes that have historically broken naive
// line parsers.
//
// Every run prints its seed, so a failure is reproducible with
// FUZZ_SEED=<value>.
'use strict';

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same sequence. */
function createRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Characters chosen for the ways they break parsers rather than for realism:
// separators a split() may collapse, quotes and backslashes, control and
// bidirectional characters, and bytes that are invalid on their own.
const HOSTILE_CHARS = [
  ' ', '\t', '\n', '\r', '\v', '\f', '\0', ':', '=', ',', '.', '/', '\\',
  '"', "'", '`', '|', '<', '>', '(', ')', '[', ']', '{', '}', '-', '+',
  '%', '$', '#', '&', '*', '?', '!', ';', '~', '^',
  '', '', '​', '‮', '﻿', '�',
  'あ', '🙂', 'é', 'İ',
];

const TOKENS = [
  '0', '1', '-1', '999999999999999999999', '0x41', 'NaN', 'Infinity',
  '255.255.255.255', '0.0.0.0', '::1', 'fe80::1%eth0', '192.168.1.1',
  'aa:bb:cc:dd:ee:ff', 'FF:FF:FF:FF:FF:FF', 'tcp', 'udp', 'icmp',
  'ESTABLISHED', 'TIME_WAIT', 'src', 'dst', 'sport', 'dport', 'mark',
  '__proto__', 'constructor', 'prototype', 'toString',
];

function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length];
}

function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/** A run of hostile characters and tokens with no structure at all. */
function randomNoise(random, maxLength = 200) {
  const length = randomInt(random, 0, maxLength);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += random() < 0.3 ? pick(random, TOKENS) : pick(random, HOSTILE_CHARS);
  }
  return out;
}

/**
 * Corrupt a realistic line so it stays close to the shape a parser expects
 * while violating it. This finds more than pure noise, which most parsers
 * reject on the first field.
 */
function mutate(random, sample) {
  const operations = [
    // Truncate: a partial read or a line cut by a buffer boundary.
    (s) => s.slice(0, randomInt(random, 0, s.length)),
    // Duplicate a separator run.
    (s) => s.replace(/\s+/, (m) => m.repeat(randomInt(random, 2, 20))),
    // Drop a random character.
    (s) => {
      const at = randomInt(random, 0, Math.max(0, s.length - 1));
      return s.slice(0, at) + s.slice(at + 1);
    },
    // Insert hostile characters mid-line.
    (s) => {
      const at = randomInt(random, 0, s.length);
      return s.slice(0, at) + pick(random, HOSTILE_CHARS) + s.slice(at);
    },
    // Replace a field with a hostile token.
    (s) => s.replace(/\S+/, () => pick(random, TOKENS)),
    // Repeat the line, which turns a single-record parser into a multi one.
    (s) => `${s}\n${s}`,
    // Very long field: catches quadratic scanning and catastrophic backtracking.
    (s) => s.replace(/\S+/, 'A'.repeat(randomInt(random, 1000, 20_000))),
    // Whitespace-only.
    () => ' '.repeat(randomInt(random, 1, 5000)),
    // Append noise.
    (s) => s + randomNoise(random, 80),
  ];
  let out = sample;
  const rounds = randomInt(random, 1, 3);
  for (let i = 0; i < rounds; i += 1) out = pick(random, operations)(out);
  return out;
}

/** Inputs that are cheap to try and have broken parsers before. */
const EDGE_CASES = [
  '', ' ', '\n', '\r\n', '\t', '\0', '\n\n\n',
  '[31mred[0m',            // ANSI escape from an interactive shell
  'A'.repeat(100_000),                  // single huge token
  ' '.repeat(50_000),                   // huge whitespace run
  `${'a '.repeat(20_000)}`,             // many small fields
  '﻿leading-bom',
  '__proto__: polluted',
  '{"__proto__":{"polluted":true}}',
  'x'.repeat(1000).split('').join(':'), // many separators
  '‮RIGHT-TO-LEFT-OVERRIDE',
];

/**
 * Run `check` over generated inputs, enforcing a per-input time budget so an
 * infinite loop or catastrophic backtracking fails loudly instead of hanging
 * the suite.
 */
function forEachInput({ samples, iterations, seed, budgetMs = 250 }, check) {
  const random = createRandom(seed);
  const failures = [];
  const inputs = [...EDGE_CASES];
  for (let i = 0; i < iterations; i += 1) {
    inputs.push(random() < 0.6 && samples.length
      ? mutate(random, pick(random, samples))
      : randomNoise(random));
  }
  for (const input of inputs) {
    const startedAt = process.hrtime.bigint();
    try {
      check(input);
    } catch (error) {
      failures.push({ kind: 'throw', input, message: error.message });
      continue;
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (elapsedMs > budgetMs) {
      failures.push({ kind: 'slow', input, message: `${elapsedMs.toFixed(1)}ms > ${budgetMs}ms` });
    }
  }
  return failures;
}

/** Render a failure compactly; raw input can be enormous. */
function describeFailure(failure) {
  const preview = JSON.stringify(failure.input.slice(0, 120));
  const suffix = failure.input.length > 120 ? ` …(${failure.input.length} chars)` : '';
  return `[${failure.kind}] ${failure.message}\n  input: ${preview}${suffix}`;
}

module.exports = {
  EDGE_CASES,
  createRandom,
  describeFailure,
  forEachInput,
  mutate,
  randomNoise,
};
