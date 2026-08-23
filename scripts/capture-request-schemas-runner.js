'use strict';

/**
 * Loaded into each test process with --require. Turns capture on before any
 * route module is imported, and prints what was seen when the process exits.
 */

const { z } = require('zod');
const capture = require('../src/request-schema-capture');

capture.enable();

// Responses are not validated on the way out -- there is no Zod schema to
// read, so the only way to describe them is to watch what comes back. This
// patches Express's `res.json` in the capture process only: it is loaded with
// --require by the generator and by nothing else, so a running Hub never sees
// it. Changing 111 routes to describe their own output would be altering the
// application to suit its documentation.
try {
  const response = require('express/lib/response');
  const original = response.json;
  response.json = function json(body) {
    try { capture.recordResponse(this, body); } catch { /* never break a response */ }
    return original.apply(this, arguments);
  };
} catch {
  // No express in this test process; request capture still works.
}

process.on('exit', () => {
  const bodies = {};
  for (const [route, schema] of capture.snapshot()) {
    try {
      // Zod 4 emits JSON Schema itself, so no dependency is added for this.
      bodies[route] = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    } catch {
      // A schema that cannot be expressed is left out rather than guessed at.
    }
  }
  const observedResponses = capture.responseSnapshot();
  if (!Object.keys(bodies).length && !Object.keys(observedResponses).length) return;
  process.stdout.write(
    `__REQUEST_SCHEMAS__${JSON.stringify({ bodies, responses: observedResponses })}\n`
  );
});
