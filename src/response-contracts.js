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

/**
 * What the agent is allowed to send, told to the agent.
 *
 * Constants, not a query: this response is the same on every call, so a
 * declaration can be exact rather than permissive.
 */
const agentCapabilities = z.object({
  schemaVersions: z.array(z.number()).max(BOUNDED_ARRAY_LIMIT),
  maxObservationsPerBatch: z.number(),
  maxBodyBytes: z.number(),
  requestsPerMinute: z.number(),
  compression: z.array(z.string()).max(BOUNDED_ARRAY_LIMIT),
}).loose();

function createRegistry() {
  const registry = createResponseContractRegistry();

  // Refusals, wherever they come from. Measured across the whole document on
  // 2026-08-25: every error body carries `error` as a string, and the variants
  // only *add* fields (`ok`, `success`, `hint`, `requestId`, `job`, `code`).
  // The single exception is `GET /readyz` 503, which is on the never-enforced
  // list because a readiness check must answer when everything else is broken.
  for (const status of [400, 401, 403, 409, 413, 415, 429, 500]) {
    registry.declareEnvelope(status, errorEnvelope);
  }

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

  // GET /api/auth/sessions -- browser sessions for one Hub. `listSessions`
  // returns what is held in memory; a Hub with more than 500 live sessions has
  // a different problem than this contract.
  registry.declare('GET /api/auth/sessions', 200, z.object({
    sessions: z.array(z.object({ id: z.number() }).loose()).max(BOUNDED_ARRAY_LIMIT),
  }).loose());

  // GET /api/agent/capabilities -- constants, so this can be exact.
  registry.declare('GET /api/agent/capabilities', 200, agentCapabilities);

  // GET /api/notes -- one note per device on this network.
  registry.declare('GET /api/notes', 200, z.object({
    notes: z.union([
      z.array(z.unknown()).max(BOUNDED_ARRAY_LIMIT),
      z.record(z.string(), z.unknown()),
    ]),
  }).loose());

  return registry;
}

module.exports = { agentCapabilities, auditEvent, createRegistry, errorEnvelope };
