#!/usr/bin/env node
'use strict';

/**
 * Runs the test suite with response-contract checking on, and fails if a
 * declared contract was broken or never checked at all (P2-95, step 3).
 *
 * Two failures, deliberately:
 *
 * **A violation** means the server returned something its contract does not
 * describe. That is the check doing its job.
 *
 * **An unverified contract** means a declaration nobody exercised. It reads as
 * success in every report and proves nothing, which is the shape of three
 * defects found on 2026-08-24 -- wiring that never fired, a view never
 * rendered, a test whose subject had been disconnected. A contract that is
 * never checked is not a contract; it is a sentence in a file.
 *
 * An undeclared route is *not* a failure. 84 of them still carry observed
 * shapes and that is the work remaining, not a regression.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { createRegistry } = require('../src/response-contracts');
const { testFiles } = require('./capture-request-schemas');

const ROOT = path.join(__dirname, '..');
const MARKER = '__RESPONSE_CONTRACTS__';

function collect(output) {
  const violations = [];
  const verified = new Set();
  let unresolved = 0;
  for (const line of output.split('\n')) {
    const at = line.indexOf(MARKER);
    if (at === -1) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(at + MARKER.length));
    } catch {
      continue;
    }
    violations.push(...(payload.violations || []));
    for (const key of payload.verified || []) verified.add(key);
    unresolved += payload.unresolved || 0;
  }
  return { violations, verified, unresolved };
}

function declaredKeys() {
  const registry = createRegistry();
  const keys = [];
  for (const route of registry.declaredRoutes()) {
    // The registry is keyed by route and status; ask it which statuses it
    // holds rather than guessing at the usual ones.
    for (let status = 100; status < 600; status += 1) {
      if (registry.lookup(route, status)) keys.push(`${route} ${status}`);
    }
  }
  return keys.sort();
}

function main() {
  const runner = path.join(__dirname, 'check-response-contracts-runner.js');
  let output = '';
  try {
    output = execFileSync(process.execPath, ['--test', ...testFiles()], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: `--require ${runner}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A failing suite is its own problem; say so rather than reporting
    // contract results gathered from a run that did not finish.
    process.stderr.write(`${(error.stdout || '').split('\n').slice(-40).join('\n')}\n`);
    process.stderr.write('Test suite failed; response contracts were not checked.\n');
    process.exit(error.status || 1);
  }

  const { violations, verified, unresolved } = collect(output);
  const declared = declaredKeys();
  const unverified = declared.filter((key) => !verified.has(key));

  process.stdout.write(`Declared response contracts: ${declared.length}\n`);
  process.stdout.write(`  checked at least once:     ${verified.size}\n`);
  process.stdout.write(`  never exercised:           ${unverified.length}\n`);
  process.stdout.write(`  violations:                ${violations.length}\n`);
  // Ordinary: a rejection before any route matched has no `req.route` to name.
  process.stdout.write(`  responses with no resolvable route: ${unresolved}\n`);

  for (const violation of violations) {
    process.stderr.write(
      `\n${violation.route} ${violation.status} does not match its contract:\n`
    );
    for (const issue of violation.issues) process.stderr.write(`  ${issue}\n`);
  }
  for (const key of unverified) {
    process.stderr.write(`\n${key} is declared but nothing exercised it.\n`);
  }

  if (violations.length || unverified.length) {
    process.stderr.write(
      '\nA contract that is never checked proves nothing, and one that is broken\n'
      + 'is worse than none. Fix the response, the declaration, or the test that\n'
      + 'should have reached it.\n'
    );
    process.exit(1);
  }
  process.stdout.write('Every declared response contract held.\n');
}

if (require.main === module) main();

module.exports = { collect, declaredKeys };
