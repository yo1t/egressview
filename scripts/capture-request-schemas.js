#!/usr/bin/env node
'use strict';

/**
 * Runs the unit tests with schema capture on and writes what the server
 * actually validated (P2-89).
 *
 * Derived from behaviour rather than from a hand-written list, because a list
 * tying routes to schemas would go stale the first time a route changed --
 * which is the failure this whole contract exists to avoid.
 *
 * Coverage is therefore whatever the tests exercise. That is a real limit and
 * the document says so rather than implying it describes everything.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'request-schemas.json');

/**
 * Tests that compare the committed document to what the generator would
 * produce.
 *
 * Running these *during* capture means any change to the generator blocks its
 * own regeneration: the document cannot be updated until it matches, and it
 * cannot match until it is updated. Hit three times on 2026-08-24 and -25,
 * the third time in a new file -- which is why this is a named class with a
 * rule rather than one filename.
 *
 * A test belongs here when it reads `docs/openapi.json` and asserts something
 * about how it was generated. It does not belong here for reading the document
 * to check a property of the API itself.
 */
const ARTIFACT_DRIFT_TESTS = [
  'openapi-contract.test.js',
  'response-contract-generation.test.js',
];

/** The suite, minus the checks on the artifact being regenerated. */
function testFiles({ includeDriftCheck = false } = {}) {
  const dir = path.join(ROOT, 'test', 'unit');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => includeDriftCheck || !ARTIFACT_DRIFT_TESTS.includes(f))
    .map((f) => path.join('test', 'unit', f));
}

if (require.main === module) {
  const runner = path.join(__dirname, 'capture-request-schemas-runner.js');
  const out = execFileSync(process.execPath, ['--test', ...testFiles()], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `--require ${runner}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // `node --test` runs a process per file, so there is one line per file that
  // saw anything. Merging them is the point: no single test file exercises
  // more than a handful of routes.
  const bodies = {};
  const responses = {};
  const { merge } = require('../src/request-schema-capture');
  for (const line of out.split('\n')) {
    const at = line.indexOf('__REQUEST_SCHEMAS__');
    if (at < 0) continue;
    const chunk = JSON.parse(line.slice(at + '__REQUEST_SCHEMAS__'.length));
    for (const [route, schema] of Object.entries(chunk.bodies || {})) {
      // First writer wins, and the keys are sorted below, so the output does
      // not depend on which test file happened to finish first.
      if (!(route in bodies)) bodies[route] = schema;
    }
    // Responses are merged rather than first-wins: a field one test file
    // happened not to exercise must not become required for everyone.
    for (const [route, byStatus] of Object.entries(chunk.responses || {})) {
      responses[route] = responses[route] || {};
      for (const [status, schema] of Object.entries(byStatus)) {
        responses[route][status] = responses[route][status]
          ? merge(responses[route][status], schema)
          : schema;
      }
    }
  }
  if (!Object.keys(bodies).length) throw new Error('The capture runner produced nothing');
  const sortKeys = (o) => Object.fromEntries(
    Object.entries(o).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(OUTPUT, `${JSON.stringify({
    bodies: sortKeys(bodies), responses: sortKeys(responses),
  }, null, 2)}\n`);
  process.stderr.write(
    `Wrote ${path.relative(ROOT, OUTPUT)}: ${Object.keys(bodies).length} request bodies, `
    + `${Object.keys(responses).length} routes with observed responses\n`
  );
}

module.exports = { ARTIFACT_DRIFT_TESTS, OUTPUT, testFiles };
