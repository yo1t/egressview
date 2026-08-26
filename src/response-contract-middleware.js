'use strict';

/**
 * Watches responses against their contracts, in a running Hub (P2-95, step 4).
 *
 * **Observes. It does not refuse.** Nothing here changes what a caller
 * receives: a response that breaks its contract is counted and logged, and
 * then sent exactly as it was. Production enforcement is step 5 and 6, route
 * by route, after this has run long enough to say what it would have refused.
 *
 * Off unless configured. A Hub that has not asked for this pays a mode check
 * per response and nothing else.
 */

const {
  MODES,
  classifyResponse,
  createResponseContractDiagnostics,
  isEnforcedRoute,
  routeKey,
} = require('./response-contract');
const { createRegistry } = require('./response-contracts');

const DEFAULT_MODE = 'off';

/**
 * How many distinct violations to describe before keeping only counts.
 *
 * A Hub returning a broken shape returns it on every request, and a log that
 * repeats the same finding thousands of times buries the second one.
 */
const MAX_REPORTED_VIOLATIONS = 20;

function resolveMode(value) {
  const mode = String(value || DEFAULT_MODE).toLowerCase();
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

/**
 * @param {object} options
 * @param {string} [options.mode] `off`, `observe`, or `enforce`. Anything
 *   unrecognised falls back to `off`: a typo in configuration must not be a
 *   silent decision to start refusing responses.
 * @param {{ warn: Function }} [options.logger]
 */
function createResponseContractMiddleware({
  mode = process.env.EGRESSVIEW_RESPONSE_CONTRACTS,
  logger = console,
  registry = createRegistry(),
  diagnostics = createResponseContractDiagnostics(),
  now = () => Date.now(),
} = {}) {
  const active = resolveMode(mode);
  const reported = new Set();
  let checkedNanos = 0;

  function report(route, status, result) {
    const key = `${route} ${status}`;
    if (reported.has(key) || reported.size >= MAX_REPORTED_VIOLATIONS) return;
    reported.add(key);
    const issues = result.error.issues.slice(0, 4).map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    );
    // Route, status and the field names that did not match -- never the value
    // that did not match it. A response body is the user's data, and a log
    // line describing a contract must not become a copy of it.
    logger.warn(
      `[response-contract] ${key} does not match its contract: ${issues.join('; ')}`
    );
  }

  function middleware(req, res, next) {
    if (active === 'off') return next();
    const originalJson = res.json;
    res.json = function json(body) {
      try {
        const route = routeKey(req);
        const decision = classifyResponse({
          mode: active, route, status: res.statusCode, registry,
        });
        switch (decision.action) {
          case 'never-enforced':
            diagnostics.recordNeverEnforced();
            break;
          case 'unmatched':
            diagnostics.recordUnmatched(route);
            break;
          case 'skip':
            break;
          default: {
            const started = process.hrtime.bigint();
            const result = decision.contract.schema.safeParse(body);
            checkedNanos += Number(process.hrtime.bigint() - started);
            if (result.success) {
              diagnostics.recordMatched();
            } else {
              diagnostics.recordViolation(route || `(before any route) ${res.statusCode}`);
              report(route || '(before any route)', res.statusCode, result);
              // Refused only for a route that was put on the list one at a
              // time, and only for a success response: replacing a 4xx with a
              // 5xx tells the caller less than the original already did.
              if (active === 'enforce' && isEnforcedRoute(route, res.statusCode)) {
                this.status(500);
                return originalJson.call(this, { error: 'Response did not match its contract' });
              }
            }
            break;
          }
        }
      } catch (error) {
        // Checking a response must never be the reason one fails to send.
        try { logger.warn(`[response-contract] check failed: ${error.message}`); } catch { /* nothing left to do */ }
      }
      return originalJson.call(this, body);
    };
    return next();
  }

  middleware.mode = active;
  middleware.snapshot = () => ({
    mode: active,
    startedAt: now(),
    checkedMilliseconds: Math.round(checkedNanos / 1e6),
    ...diagnostics.snapshot(),
  });

  return middleware;
}

module.exports = {
  DEFAULT_MODE,
  MAX_REPORTED_VIOLATIONS,
  createResponseContractMiddleware,
  resolveMode,
};
