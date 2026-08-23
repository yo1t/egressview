'use strict';

/**
 * Records which schema the server validates a request against (P2-89).
 *
 * The OpenAPI document is generated from the permission matrix, which knows
 * every route but nothing about payloads. The schemas live beside their
 * handlers, and there is no list tying the two together -- so rather than
 * writing one by hand, which would go stale the first time a route changed,
 * this observes what actually happens: `parseRequest` reports the route and
 * the schema it just used, and the test suite exercises the routes.
 *
 * **Off unless asked for.** Capture costs a lookup per request and holds
 * schemas alive, neither of which a running Hub should pay for. The generator
 * turns it on; nothing else does.
 */

const captured = new Map();
let enabled = false;

function enable() {
  enabled = true;
  captured.clear();
}

function isEnabled() { return enabled; }

/**
 * The route as the permission matrix spells it, so the two can be joined.
 * Express gives the pattern with its parameters intact, which is what the
 * matrix uses.
 */
function routeKey(req) {
  if (!req) return null;
  const method = String(req.method || '').toUpperCase();
  const base = req.baseUrl || '';
  const path = req.route?.path;
  if (!method || typeof path !== 'string') return null;
  const full = `${base}${path === '/' && base ? '' : path}`;
  return full.startsWith('/') ? `${method} ${full}` : null;
}

/**
 * Bodies only. Query strings and path parameters are validated through the
 * same helper, and describing them as request bodies would be a false
 * contract -- the point of this document is that what it says is true.
 */
function record(schema, value, res) {
  if (!enabled) return;
  const req = res?.req;
  if (!req || value !== req.body) return;
  const key = routeKey(req);
  if (!key || captured.has(key)) return;
  captured.set(key, schema);
}

function snapshot() { return new Map(captured); }

module.exports = { enable, isEnabled, record, routeKey, snapshot };
