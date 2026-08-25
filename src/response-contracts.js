'use strict';

/**
 * What the Hub declares its responses to be (P2-95, step 2).
 *
 * These are written from the handlers, not from what the test suite was seen
 * to produce. That difference is the whole point of this step: the 170 schemas
 * in the OpenAPI document today are observations, and an observation is only
 * as complete as the paths the tests happened to walk. `GET /api/status` is
 * the example that makes it concrete -- it spreads
 * `offlinePolicy.describe()` into its body, and because no test runs in
 * offline mode, the observed schema has never contained a single one of those
 * fields.
 *
 * **Extra fields are allowed by default.** A response that grows a field must
 * not start failing; that is an additive change and breaking on it would make
 * the contract an obstacle rather than a check. The exception is deliberate
 * and narrow: a response carrying settings, credentials or provider
 * configuration gets a strict projection, because "nothing extra leaked" is
 * exactly the property worth checking there. A tool that shows people what
 * leaves their machine cannot be indifferent to what leaks out of its own API.
 *
 * Declared centrally for now so the generator has one import rather than
 * depending on every route module having been loaded first -- an import-order
 * dependency would decide the contents of a document by accident.
 */

const { z } = require('zod');
const {
  BOUNDED_ARRAY_LIMIT,
  createResponseContractRegistry,
} = require('./response-contract');

/**
 * The body every refusal shares.
 *
 * **Not declared against any route, and that is a finding rather than an
 * omission.** It was, until the step-3 gate reported all four such contracts
 * as never exercised: a 401 or 403 is produced by the authentication
 * middleware *before* a route matches, so `req.route` does not exist and the
 * response cannot be attributed to the route it was heading for. Declaring it
 * per route said something untrue about where it comes from.
 *
 * It belongs to the middleware and will be declared there, once keyed by
 * something that exists at the moment it is sent. Exported meanwhile so the
 * shape is written down once.
 */
const errorEnvelope = z.object({ error: z.string() });

/**
 * One audit row as `auth-audit.list` selects it.
 *
 * `metadata` is stored as text and may be absent; the hashes are hashes and
 * never the values they stand for.
 */
const auditEvent = z.object({
  eventId: z.string(),
  createdAt: z.number(),
  eventType: z.string(),
  outcome: z.string(),
  authMethod: z.string().nullable().optional(),
  actorHash: z.string().nullable().optional(),
  principalHash: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  clientIpHash: z.string().nullable().optional(),
  httpMethod: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  metadata: z.string().nullable().optional(),
});

function createRegistry() {
  const registry = createResponseContractRegistry();

  // GET /api/status -- the offline fields are why this is not `.strict()`.
  registry.declare('GET /api/status', 200, z.object({
    authenticated: z.boolean(),
    routerIp: z.string().nullable(),
    enrichment: z.object({}).loose(),
  }).loose());

  // GET /api/auth/audit-events -- `list` clamps its limit to 500, which is
  // what makes this bounded rather than a promise nobody keeps.
  registry.declare('GET /api/auth/audit-events', 200, z.object({
    events: z.array(auditEvent).max(BOUNDED_ARRAY_LIMIT),
  }).loose());

  return registry;
}

module.exports = { auditEvent, createRegistry, errorEnvelope };
