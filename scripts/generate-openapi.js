#!/usr/bin/env node
'use strict';

/**
 * Generate the OpenAPI description of the HTTP surface from the permission
 * matrix (P2-89).
 *
 * Generated rather than written, because a hand-written contract goes stale
 * the first time someone adds a route and forgets it. That has already
 * happened here in a smaller way: the sitemap was hand-written and listed two
 * URLs for a site serving more than forty pages.
 *
 * **This describes the access surface, not the payloads.** Every route, its
 * method, and exactly what authentication and permission it demands are taken
 * from `src/permission-matrix.js`, which is the same object the server
 * enforces. Request and response bodies are validated by Zod at the route and
 * are not yet described here; saying so is better than shipping a contract
 * that quietly describes half of what it claims to.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  ACCESS, HTTP_ROUTE_MATRIX, MCP_TOOL_PERMISSIONS,
} = require('../src/permission-matrix');
const { ALL_PERMISSIONS, AGENT_PERMISSIONS } = require('../src/permissions');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'openapi.json');
// Captured from what the server actually validated, not written by hand; see
// scripts/capture-request-schemas.js.
const BODIES = path.join(ROOT, 'docs', 'request-schemas.json');

const SECURITY_SCHEMES = {
  sessionCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: 'egressview_session',
    description:
      'Browser session. HttpOnly, and state-changing requests additionally '
      + 'require the CSRF token issued with it.',
  },
  apiToken: {
    type: 'http',
    scheme: 'bearer',
    description:
      'An API identity token. Stored only as a hash, so a copy of the '
      + 'database does not yield a usable credential.',
  },
  agentToken: {
    type: 'http',
    scheme: 'bearer',
    description:
      'An enrolled agent, prefixed egva_. A separate access class: an agent '
      + 'token cannot reach a route in any other class, and a session cannot '
      + 'reach an agent route.',
  },
};

function securityFor(route) {
  switch (route.access) {
    case ACCESS.PUBLIC:
      return [];
    case ACCESS.AGENT:
      return [{ agentToken: [] }];
    case ACCESS.AUTHENTICATED:
      return [{ sessionCookie: [] }, { apiToken: [] }];
    case ACCESS.PERMISSION:
      // The permissions are listed as scopes so the requirement is machine
      // readable rather than only described in prose.
      return [
        { sessionCookie: route.permissions },
        { apiToken: route.permissions },
      ];
    default:
      throw new Error(`Unknown access class: ${route.access}`);
  }
}

function describe(route) {
  if (route.access === ACCESS.PUBLIC) return 'No authentication.';
  if (route.access === ACCESS.AGENT) return 'Requires an enrolled agent token.';
  if (route.access === ACCESS.AUTHENTICATED) return 'Requires any authenticated identity.';
  return `Requires ${route.permissions.map((p) => `\`${p}\``).join(' and ')}.`;
}

function captured() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BODIES, 'utf8'));
    return { bodies: parsed.bodies || {}, responses: parsed.responses || {} };
  } catch {
    return { bodies: {}, responses: {} };
  }
}

/**
 * What a route was seen to return under test, described as such.
 *
 * Nothing validates a response on the way out, so unlike the request bodies
 * these are not read off a schema the server enforces -- they are observations.
 * Every one is marked, because a reader who treats an observation as a
 * guarantee has been misled by this document rather than helped by it.
 */
function responsesFor(route, observed) {
  const seen = observed[`${route.method} ${route.path}`];
  const out = {
    200: { description: 'Handled.' },
    ...(route.access === ACCESS.PUBLIC ? {} : {
      401: { description: 'No usable credential.' },
      403: { description: 'Authenticated, but not permitted.' },
    }),
  };
  for (const [status, schema] of Object.entries(seen || {})) {
    out[status] = {
      description: (out[status]?.description || 'Observed under test.')
        + ' Shape observed under test, not a guarantee: responses are not validated on the way out.',
      content: {
        'application/json': {
          schema: { ...schema, 'x-observed': true },
        },
      },
    };
  }
  return out;
}

function build({ version } = {}) {
  const { bodies, responses: observed } = captured();
  const paths = {};
  // Sorted so the generated file is stable: an unordered object would produce
  // a different document on every run and make the drift check meaningless.
  const routes = [...HTTP_ROUTE_MATRIX].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
  for (const route of routes) {
    const item = paths[route.path] || (paths[route.path] = {});
    const body = bodies[`${route.method} ${route.path}`];
    item[route.method.toLowerCase()] = {
      summary: `${route.method} ${route.path}`,
      description: describe(route)
        + (body ? '' : ' The request body is not described here.'),
      security: securityFor(route),
      ...(body ? {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: body } },
        },
      } : {}),
      responses: responsesFor(route, observed),
    };
  }

  return {
    openapi: '3.1.0',
    servers: [{
      // Self-hosted, so there is no canonical address; the scheme is the part
      // that matters here. Every credential this document describes -- session
      // cookie, API token, agent token -- is a bearer secret, and describing
      // them without saying they travel over TLS would describe a different,
      // worse system than the one that exists.
      url: 'https://{host}{basePath}',
      description: 'Your own Hub. HTTPS only: the credentials below are bearer secrets.',
      variables: {
        host: { default: 'egressview.example', description: 'The host you run the Hub on' },
        basePath: { default: '', description: 'Set when the Hub is served under a subpath' },
      },
    }],
    // Protected by default, so a route added without a security block is
    // described as requiring a credential rather than as open. The ten public
    // routes override this with an explicit empty list.
    security: [{ sessionCookie: [] }, { apiToken: [] }],
    info: {
      title: 'EgressView Hub HTTP API',
      version: version || require('../package.json').version,
      description:
        'Generated from src/permission-matrix.js, the same object the server '
        + 'enforces, so this cannot describe a route the server does not have '
        + 'or miss one it does.\n\n'
        + 'Request bodies are described for the routes the test suite '
        + 'exercises, captured from the schema the server actually validated '
        + 'rather than written by hand -- a hand-written list would go stale '
        + 'the first time a route changed. Operations without one say so in '
        + 'their description.\n\n'
        + 'Response shapes are **observed**, not enforced: nothing validates a '
        + 'response on the way out, so these describe what routes were seen to '
        + 'return under test. Each is marked `x-observed`. **Treat them as '
        + 'documentation of behaviour, not as a promise.**\n\n'
        + 'Regenerate with `npm run docs:openapi`, which re-captures first.',
      license: { name: 'AGPL-3.0-only' },
    },
    components: {
      securitySchemes: SECURITY_SCHEMES,
      'x-permissions': [...ALL_PERMISSIONS, ...Object.values(AGENT_PERMISSIONS)].sort(),
      'x-mcpTools': Object.fromEntries(
        Object.entries(MCP_TOOL_PERMISSIONS).sort(([a], [b]) => a.localeCompare(b))
      ),
    },
    paths,
  };
}

function render(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (require.main === module) {
  fs.writeFileSync(OUTPUT, render(build()));
  process.stderr.write(`Wrote ${path.relative(ROOT, OUTPUT)}\n`);
}

module.exports = { build, render, OUTPUT, SECURITY_SCHEMES };
