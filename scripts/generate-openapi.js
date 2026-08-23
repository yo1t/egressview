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

function build({ version } = {}) {
  const paths = {};
  // Sorted so the generated file is stable: an unordered object would produce
  // a different document on every run and make the drift check meaningless.
  const routes = [...HTTP_ROUTE_MATRIX].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
  );
  for (const route of routes) {
    const item = paths[route.path] || (paths[route.path] = {});
    item[route.method.toLowerCase()] = {
      summary: `${route.method} ${route.path}`,
      description: describe(route),
      security: securityFor(route),
      responses: {
        // Only what the access surface implies. A body schema asserted here
        // without being generated from the route's Zod schema would be a
        // guess presented as a contract.
        200: { description: 'Handled.' },
        ...(route.access === ACCESS.PUBLIC ? {} : {
          401: { description: 'No usable credential.' },
          403: { description: 'Authenticated, but not permitted.' },
        }),
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'EgressView Hub HTTP API',
      version: version || require('../package.json').version,
      description:
        'Generated from src/permission-matrix.js, the same object the server '
        + 'enforces, so this cannot describe a route the server does not have '
        + 'or miss one it does.\n\n'
        + '**This describes the access surface, not the payloads.** Request '
        + 'and response bodies are validated by Zod at the route and by CHECK '
        + 'constraints at rest; they are not described here yet. Regenerate '
        + 'with `npm run docs:openapi`.',
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
