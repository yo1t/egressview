'use strict';

/**
 * Loaded into each test process with --require. Turns capture on before any
 * route module is imported, and prints what was seen when the process exits.
 */

const { z } = require('zod');
const capture = require('../src/request-schema-capture');

capture.enable();

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
  if (!Object.keys(bodies).length) return;
  process.stdout.write(`__REQUEST_SCHEMAS__${JSON.stringify({ bodies })}\n`);
});
