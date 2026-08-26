'use strict';

/**
 * Where response contracts will live, and the counters that say whether they
 * are being found (P2-95, step 1).
 *
 * **This changes no runtime behaviour.** Nothing here is installed as
 * middleware and no response is inspected. It exists so that the following
 * steps — generating the OpenAPI document from these declarations, enforcing
 * them in CI, then observing on the Hub before enforcing anything in
 * production — have one registry to work from rather than three.
 *
 * The order matters. The 170 response schemas in `docs/openapi.json` today are
 * `x-observed`: generated from whatever the test suite happened to produce.
 * Enforcing those in production would reject a legitimate response the moment
 * a code path the tests never exercised returns something the samples did not
 * contain. So the schemas become declarations *before* anything enforces them,
 * and this file is where the declarations go.
 */

const { routeKey } = require('./request-schema-capture');

/**
 * Off, watching, or refusing.
 *
 * `observe` records what would have failed. `enforce` is what "the response
 * matches its contract" is allowed to mean — and it is deliberately not
 * reachable by sampling. See `BOUNDED_ARRAY_LIMIT`.
 */
const MODES = Object.freeze(['off', 'observe', 'enforce']);

/**
 * The single definition of "bounded", so it is not a judgement each reviewer
 * re-makes.
 *
 * A response is bounded when every array it can contain has at most this many
 * elements — by pagination, or by a cap the route itself applies. **A route
 * that can exceed it is not enforced in production**: validating the first N
 * elements and calling the response checked would be false, because element
 * N+1 is exactly where an unchecked one would be.
 */
const BOUNDED_ARRAY_LIMIT = 500;

/**
 * Never enforced in production, on purpose, with the reason attached.
 *
 * These are not "not done yet". `/healthz` and `/readyz` are the clearest
 * case: on 2026-08-24 a Hub that failed to start took the deploy down through
 * `/readyz`, and the ALB marks a target unhealthy by the same signal. A
 * healthy Hub must never be declared unhealthy because a field was missing
 * from a contract. The rest do not return JSON at all.
 */
const NEVER_ENFORCED = Object.freeze([
  Object.freeze({ route: 'GET /healthz', reason: 'health must answer when everything else is broken' }),
  Object.freeze({ route: 'GET /readyz', reason: 'a failed check rolls back a deploy and drains the ALB target' }),
  Object.freeze({ route: 'GET /api/connections/export', reason: 'streams CSV or JSON Lines, not a JSON body' }),
  Object.freeze({ route: 'GET /api/backup/download/:name', reason: 'sends a backup file, not a JSON body' }),
  Object.freeze({ route: 'GET /api/auth/oidc/start', reason: 'redirects to the identity provider; no body to check' }),
  Object.freeze({ route: 'GET /api/auth/oidc/callback', reason: 'redirects back into the app; no body to check' }),
]);

const NEVER_ENFORCED_ROUTES = new Set(NEVER_ENFORCED.map((entry) => entry.route));

/**
 * Routes whose responses are refused in production when they break contract.
 *
 * **Empty on purpose, and adding to it is a decision each time.** Enforcing
 * replaces a response that is slightly wrong with one that is definitely
 * broken, so it earns its place only where sending the wrong thing is worse
 * than sending nothing -- a body carrying settings, credentials or provider
 * configuration, where an unexpected field is a leak rather than a mismatch.
 *
 * Ordinary shape drift does not belong here. It is caught in CI before it
 * ships and counted in production after; turning it into a 500 would take a
 * working screen away from someone to report a documentation problem.
 *
 * Measured 2026-08-25, fifteen minutes of real traffic: 136 responses checked
 * against 15 contracts, **zero violations**, 0.05 ms each. The cost is not
 * what makes this list short.
 */
const ENFORCED_ROUTES = Object.freeze([
  Object.freeze({
    route: 'GET /api/auth/security-config',
    reason: 'the OIDC client secret is projected to `clientSecretSet`; an extra key here is a leak',
  }),
  Object.freeze({
    route: 'GET /api/config/ai',
    reason: 'every provider key is projected to `keySet`; an extra key here is a leak',
  }),
]);

const ENFORCED_ROUTE_SET = new Set(ENFORCED_ROUTES.map((entry) => entry.route));

/**
 * Refusal applies to success responses only. Replacing a 4xx or 5xx with a
 * different 5xx tells the caller less than the original did, and the original
 * was already telling them something went wrong.
 */
function isEnforcedRoute(route, status) {
  return ENFORCED_ROUTE_SET.has(route) && status >= 200 && status < 300;
}

function isNeverEnforced(route) {
  return NEVER_ENFORCED_ROUTES.has(route);
}

/**
 * A contract per route and status.
 *
 * Keyed the way `request-schema-capture` keys routes, deliberately: two route
 * resolvers that disagree would send one of them looking up a contract that
 * does not exist and calling the miss a pass.
 */
function createResponseContractRegistry() {
  const contracts = new Map();
  const envelopes = new Map();

  function key(route, status) { return `${route} ${status}`; }

  return {
    /**
     * @param {string} route  as `routeKey` spells it: `GET /api/devices/:id`
     * @param {number} status
     * @param {{ safeParse: Function }} schema
     * @param {{ bounded?: boolean, arrayElementsObserved?: boolean }} [options]
     *   `arrayElementsObserved` marks a contract that describes the envelope
     *   but not every element. The OpenAPI document has to say so too: a
     *   reader must not take "declared" to mean the elements were checked.
     */
    declare(route, status, schema, options = {}) {
      if (typeof route !== 'string' || !route.includes(' ')) {
        throw new TypeError(`Response contract needs a route like "GET /api/x", got ${route}`);
      }
      if (!Number.isInteger(status)) {
        throw new TypeError(`Response contract needs a status code, got ${status}`);
      }
      if (!schema || typeof schema.safeParse !== 'function') {
        throw new TypeError(`Response contract for ${route} ${status} needs a schema`);
      }
      contracts.set(key(route, status), {
        route,
        status,
        schema,
        bounded: options.bounded !== false,
        arrayElementsObserved: Boolean(options.arrayElementsObserved),
      });
      return this;
    },

    /**
     * A contract for a status wherever it is produced, not for one route.
     *
     * Refusals are not the route's doing. Measured 2026-08-25: every response
     * the suite could not attribute to a route came from middleware -- rate
     * limiting, authentication, a body too large, a body that would not parse
     * -- and `req.route` does not exist yet when those are sent. Declaring
     * them per route said something untrue about where they come from.
     */
    declareEnvelope(status, schema) {
      if (!Number.isInteger(status)) {
        throw new TypeError(`Envelope contract needs a status code, got ${status}`);
      }
      if (!schema || typeof schema.safeParse !== 'function') {
        throw new TypeError(`Envelope contract for ${status} needs a schema`);
      }
      envelopes.set(status, { status, schema, bounded: true, envelope: true });
      return this;
    },

    lookupEnvelope(status) { return envelopes.get(status) || null; },
    envelopeStatuses() { return [...envelopes.keys()].sort((a, b) => a - b); },

    lookup(route, status) { return contracts.get(key(route, status)) || null; },
    declaredRoutes() { return [...new Set([...contracts.values()].map((c) => c.route))].sort(); },
    get size() { return contracts.size; },
  };
}

/**
 * What the lookup did, counted.
 *
 * `unmatched` is the number that matters. A route whose contract cannot be
 * found is not a passing route -- it is a route nobody is checking, and the
 * failure mode of this whole feature is that those are silently counted as
 * fine. Three defects found on 2026-08-24 had exactly that shape: wiring that
 * never fired, a view that was never rendered, a test whose subject had been
 * disconnected. Every one of them looked like success.
 */
function createResponseContractDiagnostics() {
  const counts = { matched: 0, unmatched: 0, neverEnforced: 0, violations: 0 };
  const unmatchedRoutes = new Map();
  const violatingRoutes = new Map();

  function bump(map, route) { map.set(route, (map.get(route) || 0) + 1); }

  return {
    recordMatched() { counts.matched += 1; },
    recordUnmatched(route) {
      counts.unmatched += 1;
      if (route) bump(unmatchedRoutes, route);
    },
    recordNeverEnforced() { counts.neverEnforced += 1; },
    recordViolation(route) {
      counts.violations += 1;
      if (route) bump(violatingRoutes, route);
    },
    snapshot() {
      return {
        ...counts,
        unmatchedRoutes: Object.fromEntries([...unmatchedRoutes].sort()),
        violatingRoutes: Object.fromEntries([...violatingRoutes].sort()),
      };
    },
    reset() {
      counts.matched = 0;
      counts.unmatched = 0;
      counts.neverEnforced = 0;
      counts.violations = 0;
      unmatchedRoutes.clear();
      violatingRoutes.clear();
    },
  };
}

/**
 * How a response should be treated, without treating it.
 *
 * Separated from any middleware so the decision can be tested on its own, and
 * so the step that installs one has nothing left to decide.
 */
function classifyResponse({ mode, route, status, registry }) {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown response contract mode: ${mode}`);
  if (mode === 'off') return { action: 'skip', reason: 'off' };
  if (route && isNeverEnforced(route)) {
    return { action: 'never-enforced', reason: 'excluded by policy' };
  }
  // A route-specific contract wins; the envelope catches what middleware sent
  // before a route was ever chosen, which is the only thing that can be said
  // about a response nobody's handler produced.
  const contract = (route && registry.lookup(route, status))
    || registry.lookupEnvelope(status);
  if (!contract) {
    return {
      action: 'unmatched',
      reason: route ? 'no contract declared' : 'route could not be resolved',
    };
  }
  if (mode === 'enforce' && !contract.bounded) {
    // Refusing to call it enforced is the point. An unbounded array can only
    // be sampled, and a sampled response is not a checked one.
    return { action: 'observe', contract, reason: 'unbounded response is observed, not enforced' };
  }
  return { action: mode, contract };
}

module.exports = {
  BOUNDED_ARRAY_LIMIT,
  ENFORCED_ROUTES,
  isEnforcedRoute,
  MODES,
  NEVER_ENFORCED,
  classifyResponse,
  createResponseContractDiagnostics,
  createResponseContractRegistry,
  isNeverEnforced,
  routeKey,
};
