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
/// route -> status -> merged schema of every body seen at that status.
const responses = new Map();
let enabled = false;

function enable() {
  enabled = true;
  captured.clear();
  responses.clear();
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

/**
 * The shape of one value, as JSON Schema.
 *
 * Deliberately shallow about types and careful about `required`: what comes
 * back here is one example, and one example is not a contract. Merging decides
 * what survives.
 */
function shapeOf(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const items = value.reduce((acc, entry) => merge(acc, shapeOf(entry)), null);
    return items ? { type: 'array', items } : { type: 'array' };
  }
  switch (typeof value) {
    case 'string': return { type: 'string' };
    case 'boolean': return { type: 'boolean' };
    case 'number': return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'object': {
      const properties = {};
      for (const [key, entry] of Object.entries(value)) properties[key] = shapeOf(entry);
      return { type: 'object', properties, required: Object.keys(value).sort() };
    }
    default: return {};
  }
}

/**
 * Two observations of the same response, combined.
 *
 * A property is required only if it was present every time. A field that
 * appears in one response and not another is optional, and saying otherwise
 * would turn a lucky example into a promise.
 */
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type !== b.type) {
    const types = [...new Set([a.type, b.type].flat().filter(Boolean))].sort();
    return types.length ? { type: types.length === 1 ? types[0] : types } : {};
  }
  if (a.type === 'array') {
    const items = merge(a.items, b.items);
    return items ? { type: 'array', items } : { type: 'array' };
  }
  if (a.type !== 'object') return a;
  const properties = { ...a.properties };
  for (const [key, schema] of Object.entries(b.properties || {})) {
    properties[key] = properties[key] ? merge(properties[key], schema) : schema;
  }
  const required = (a.required || []).filter((key) => (b.required || []).includes(key));
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * What a route was observed to return. Not what it guarantees -- nothing
 * validates a response on the way out, so this is a description of behaviour
 * seen under test and the document has to say so.
 */
function recordResponse(res, body) {
  if (!enabled) return;
  const key = routeKey(res?.req);
  if (!key) return;
  const status = String(res.statusCode || 200);
  if (!responses.has(key)) responses.set(key, new Map());
  const byStatus = responses.get(key);
  byStatus.set(status, merge(byStatus.get(status), shapeOf(body)));
}

function snapshot() { return new Map(captured); }

function responseSnapshot() {
  const out = {};
  for (const [route, byStatus] of responses) {
    out[route] = Object.fromEntries([...byStatus].sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

module.exports = {
  enable, isEnabled, record, recordResponse, routeKey, snapshot, responseSnapshot,
  shapeOf, merge,
};
