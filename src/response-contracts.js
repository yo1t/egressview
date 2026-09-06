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

  // The routes this Hub actually serves, in the order the step-4 observer
  // reported them: agent ingest carries 71% of API traffic, and none of the
  // contracts declared before it were ever exercised in production.

  // POST /api/agent/ingest -- `batchAck`, a frozen object of counts.
  registry.declare('POST /api/agent/ingest', 200, z.object({
    batchId: z.string(),
    accepted: z.number(),
    duplicate: z.number(),
    rejected: z.number(),
    receivedAt: z.number(),
    replayed: z.boolean(),
    requestId: z.string().optional(),
  }).loose());

  // GET /api/ai/usage/monthly -- four objects, no arrays.
  registry.declare('GET /api/ai/usage/monthly', 200, z.object({
    pricing: z.object({ approximate: z.boolean() }).loose(),
    current: z.unknown(),
    previous: z.unknown(),
  }).loose());

  // GET /api/ai/facts -- counts for two periods, plus who was collecting.
  //
  // Declared from the shape `buildAiFacts` actually returns, read by calling
  // it, not from the route's reading of it. The correction in the P2-95 spec
  // exists because #315's description claimed this was declared when it was
  // not; the gate's `undeclared: GET /api/ai/facts x15` was the evidence.
  //
  // `bounded: false`: `collection.routers` has one entry per configured
  // collection source and nothing caps it. A real Hub has a handful, but "few
  // in practice" is not a bound, and a contract that says enforced when it
  // means sampled is the thing this design refuses.
  const periodCounts = z.object({
    connections: z.number(),
    devices: z.number(),
    destinations: z.number(),
    safe: z.number(),
    warn: z.number(),
    danger: z.number(),
  }).loose();
  const factsRange = z.object({
    from: z.number(),
    to: z.number(),
    durationMs: z.number(),
  }).loose();
  registry.declare('GET /api/ai/facts', 200, z.object({
    serverTime: z.number(),
    range: factsRange,
    previousRange: factsRange,
    collection: z.object({
      health: z.string(),
      enabledCount: z.number(),
      readyCount: z.number(),
      reportedSessions: z.number(),
      // Null until a collection source has succeeded once.
      lastUpdatedAt: z.number().nullable(),
      routers: z.array(z.unknown()),
    }).loose(),
    // Null when the caller did not scope the question to one source.
    sourceScope: z.unknown().nullable(),
    current: periodCounts,
    previous: periodCounts,
  }).loose(), { bounded: false, arrayElementsObserved: true });

  // GET /api/devices -- every device this Hub knows about.
  //
  // `bounded: false`: nothing caps the list. Measured on the production Hub
  // 2026-08-29: 203 devices, comfortably under the 500-element limit -- which
  // is a count, not a bound. The route has no pagination, so a larger network
  // exceeds it and the declaration must not claim otherwise.
  //
  // The elements are `z.unknown()`. A device row carries names, notes and
  // vendor strings that several subsystems extend; pinning them here would
  // make the contract an obstacle to ordinary additions rather than a check.
  registry.declare('GET /api/devices', 200, z.object({
    devices: z.array(z.unknown()),
  }).loose(), { bounded: false, arrayElementsObserved: true });

  // GET /api/connections/summary. The busiest undeclared route on the Hub
  // (x660 in one 15-minute window, 2026-09-06). It stayed undeclared because
  // its tests called the handler directly with a stand-in `res`, never
  // through Express, so nothing reached it to check the contract -- a
  // declaration nobody exercises is what this design refuses to ship.
  // `test/unit/connections-summary-http.test.js` now mounts the router and
  // requests it over HTTP, so the shape below is checked rather than asserted.
  //
  // The keys were read off the production Hub, not off the test stub: the
  // stub answers three keys, production answers fourteen. Declaring what the
  // stub returns would have pinned a contract the real response violates.
  //
  // `bounded: false` and `unknown()` elements: every array here is a
  // projection of live traffic -- 500 destinations, 245 edges, 315 timeline
  // points in one measured response -- and their rows gain fields as
  // enrichment grows. Pinning row shapes would make the contract an obstacle
  // to ordinary additions rather than a check that the envelope holds.
  registry.declare('GET /api/connections/summary', 200, z.object({
    byDst: z.array(z.unknown()),
    byDevice: z.array(z.unknown()),
    total: z.number(),
    serverTime: z.number(),
    cached: z.boolean(),
  }).loose(), { bounded: false, arrayElementsObserved: true });

  // GET /api/agents -- one row per enrolled agent, through `publicAgent`.
  //
  // The element is `.strict()` and that is the point: `listAgents` runs
  // `SELECT * FROM agents` and hands each row to a projection that drops
  // `tokenHash`. A column added to that table reaches the projection
  // automatically the day someone widens it, so "nothing extra came out" is
  // the property worth checking rather than a mismatch to tolerate.
  //
  // `bounded: false`: agents are enrolled one at a time by an administrator
  // and nothing caps how many. Two on this network today, which is a count.
  registry.declare('GET /api/agents', 200, z.object({
    agents: z.array(z.strictObject({
      agentId: z.string(),
      platform: z.string(),
      hostName: z.string(),
      osVersion: z.string(),
      agentVersion: z.string(),
      createdAt: z.number(),
      updatedAt: z.number(),
      lastSeenAt: z.number().nullable(),
      revokedAt: z.number().nullable(),
    })),
  }).loose(), { bounded: false });

  // GET /api/routers -- the collection sources, through `publicRouter`.
  //
  // Bounded for a reason that exists in the code rather than in practice:
  // `upsert` refuses an eleventh router, and the response says so in
  // `maxRouters`. The element is `.strict()` for the same reason as agents --
  // the record it is projected from holds `pass` and `enablePass`, and both
  // are meant to leave here as booleans or not at all.
  registry.declare('GET /api/routers', 200, z.object({
    routers: z.array(z.strictObject({
      id: z.string(),
      kind: z.string(),
      displayName: z.string(),
      hostName: z.string(),
      ip: z.string(),
      user: z.string(),
      // Yamaha only; `undefined` is dropped by JSON for every other kind.
      nat: z.union([z.string(), z.number()]).optional(),
      enabled: z.boolean(),
      passSet: z.boolean(),
      enablePassSet: z.boolean(),
      ready: z.boolean(),
      state: z.string(),
      message: z.string(),
      lastSuccessAt: z.number().nullable(),
      lastError: z.string().nullable(),
      sessionCount: z.number(),
    })).max(BOUNDED_ARRAY_LIMIT),
    maxRouters: z.number(),
    serverTime: z.number(),
    processStartedAt: z.number(),
  }).loose());

  // GET /api/agent/threat-intel -- the indicator set an agent matches against
  // locally, so that asking "is this dangerous?" never sends the address.
  //
  // One shape covers both answers. `available: false` is a Hub with no feeds
  // and is not an error: the agent has to tell "nothing found" apart from
  // "nobody looked", and the empty arrays below are what it reads.
  //
  // `bounded: false` and `unknown()` rows: about ten thousand indicators, sent
  // positionally as `[value, source, tag, confidence]`. The fourth element is
  // absent from a Hub older than P3-19.
  registry.declare('GET /api/agent/threat-intel', 200, z.object({
    schemaVersion: z.number(),
    generatedAt: z.string(),
    available: z.boolean(),
    fetchedAt: z.string().nullable().optional(),
    ips: z.array(z.unknown()),
    domains: z.array(z.unknown()),
    cidrs: z.array(z.unknown()),
  }).loose(), { bounded: false, arrayElementsObserved: true });

  // GET /api/ai/notification-config -- when the Hub is allowed to speak first.
  //
  // `automationProvider` is removed by the handler, and `z.undefined()` says
  // so rather than leaving it to a reader to notice: the field records which
  // provider the consent was given for, and answering it back would let a
  // screen show consent for a provider the user never agreed to.
  registry.declare('GET /api/ai/notification-config', 200, z.object({
    config: z.object({
      frequency: z.string(),
      destinations: z.object({}).loose(),
      rules: z.object({}).loose(),
      threat: z.object({}).loose(),
      automationConsent: z.boolean(),
      // Absent, not merely falsy: `z.never().optional()` passes when the key
      // is missing and fails the moment it is answered back.
      automationProvider: z.never().optional(),
    }).loose(),
    status: z.strictObject({
      running: z.boolean(),
      provider: z.string(),
      automationReady: z.boolean(),
      slackReady: z.boolean(),
    }),
  }).loose());

  // GET /api/config/detection-notifications -- the per-detection delivery
  // switches. Two channels each, no arrays, so this can be exact.
  const detectionChannels = z.strictObject({
    slack: z.boolean().optional(),
    history: z.boolean().optional(),
  });
  registry.declare('GET /api/config/detection-notifications', 200, z.object({
    config: z.strictObject({
      threat: detectionChannels,
      newDevice: detectionChannels,
    }),
  }).loose());

  // Responses that project a secret down to a fact about it. These are the
  // ones worth refusing rather than merely counting: `clientSecretSet` and
  // `keySet` exist so a credential is never sent, and an extra key here is a
  // leak rather than a mismatch. `.strict()` on purpose -- everywhere else
  // additions are allowed, because there they are additions.

  // GET /api/auth/security-config -- OIDC settings with the secret reduced to
  // a boolean by the handler.
  registry.declare('GET /api/auth/security-config', 200, z.object({
    oidc: z.strictObject({
      enabled: z.boolean(),
      provider: z.string(),
      clientId: z.string(),
      clientSecretSet: z.boolean(),
      allowedEmails: z.array(z.string()).max(BOUNDED_ARRAY_LIMIT),
      allowedDomains: z.array(z.string()).max(BOUNDED_ARRAY_LIMIT),
    }),
    sessionTtlDays: z.number(),
    trustedProxyConfigured: z.boolean(),
    warnings: z.array(z.string()).max(BOUNDED_ARRAY_LIMIT),
  }).strict());

  // GET /api/config/ai -- every provider key reduced to `keySet`.
  registry.declare('GET /api/config/ai', 200, z.object({
    provider: z.string(),
    models: z.record(z.string(), z.string()),
    ollamaEndpoint: z.string(),
    region: z.string(),
    guardrail: z.object({}).loose(),
    providers: z.record(z.string(), z.strictObject({
      keySet: z.boolean(),
      consented: z.boolean().optional(),
    })),
    selectedModelPricing: z.unknown().optional(),
  }).strict());

  // GET /api/config/slack -- the bot token reduced to `tokenSet` by
  // `notifier.getConfig`. `.strict()` because the token is the whole reason
  // this projection exists.
  registry.declare('GET /api/config/slack', 200, z.object({
    config: z.strictObject({
      enabled: z.boolean(),
      userId: z.string(),
      displayName: z.string(),
      cooldownMinutes: z.number(),
      tokenSet: z.boolean(),
    }),
  }).strict());

  // GET /api/ai/conversations/:id -- one stored conversation and its messages.
  //
  // `bounded: false` and `unknown()` rows: a conversation grows a message per
  // turn and nothing trims it while it is open, so the count is a measurement
  // rather than a limit. The rows are `SELECT *` from `ai_conversations` and
  // `ai_messages`, and pinning them here would make the contract an obstacle
  // to ordinary schema growth rather than a check that the envelope holds.
  registry.declare('GET /api/ai/conversations/:id', 200, z.object({
    conversation: z.object({ conversationId: z.string() }).loose(),
    messages: z.array(z.unknown()),
  }).loose(), { bounded: false, arrayElementsObserved: true });

  return registry;
}

module.exports = { agentCapabilities, auditEvent, createRegistry, errorEnvelope };
