'use strict';

/**
 * Loaded into each test process with --require (P2-95, step 3).
 *
 * Validates every JSON response against its declared contract, and reports
 * which declared contracts were never exercised at all. A contract nobody
 * checked is not a passing contract -- it is a promise nobody read, and the
 * failure this whole feature guards against is those being counted as fine.
 *
 * Patched here rather than in the application, exactly as the capture runner
 * does: it is loaded by this script and by nothing else, so a running Hub
 * never sees it.
 */

const { routeKey } = require('../src/response-contract');
const { createRegistry } = require('../src/response-contracts');

const registry = createRegistry();
const violations = [];
const verified = new Set();
/// Responses whose route could not be resolved. Ordinary for a rejection that
/// happens before any route matched -- `req.route` does not exist yet -- so
/// this is reported, not failed on.
let unresolved = 0;

try {
  const response = require('express/lib/response');
  const original = response.json;
  response.json = function json(body) {
    try {
      const route = routeKey(this.req);
      if (!route) {
        unresolved += 1;
      } else {
        const contract = registry.lookup(route, this.statusCode);
        if (contract) {
          const result = contract.schema.safeParse(body);
          if (result.success) {
            verified.add(`${route} ${this.statusCode}`);
          } else {
            violations.push({
              route,
              status: this.statusCode,
              issues: result.error.issues.slice(0, 4).map(
                (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
              ),
            });
          }
        }
      }
    } catch {
      // Never break a response to check one.
    }
    return original.apply(this, arguments);
  };
} catch {
  // No express in this test process; nothing to check here.
}

process.on('exit', () => {
  if (!violations.length && !verified.size && !unresolved) return;
  process.stdout.write(
    `__RESPONSE_CONTRACTS__${JSON.stringify({
      violations,
      verified: [...verified],
      unresolved,
    })}\n`
  );
});
