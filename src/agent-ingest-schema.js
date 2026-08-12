'use strict';

const net = require('node:net');
const { z } = require('zod');

const AGENT_INGEST_SCHEMA_VERSION = 1;

// Every payload version this Hub accepts, newest last. An agent updates on the
// user's machine while the Hub updates whenever its operator decides, so the
// two versions are routinely apart; accepting a range is what keeps a Hub
// usable while its agents move ahead of it. Adding an optional field is not a
// new version — versions exist for changes that break the old reader.
const AGENT_INGEST_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1]);
const AGENT_INGEST_MAX_OBSERVATIONS = 200;
const AGENT_INGEST_MAX_BODY_BYTES = 512 * 1024;
const AGENT_INGEST_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_INGEST_MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

const noControlCharacters = value => !/[\u0000-\u001f\u007f]/.test(value);
const boundedSafeText = max => z.string().min(1).max(max).refine(
  noControlCharacters,
  'must not contain control characters'
);
const nullableBoundedSafeText = max => boundedSafeText(max).nullable();
const ipLiteral = z.string().max(45).refine(value => net.isIP(value) !== 0, 'must be an IP address');
const port = z.number().int().min(1).max(65535);
const isoTimestamp = z.iso.datetime({ offset: false, local: false }).max(32);
const uint64Decimal = z.string().regex(/^(?:0|[1-9]\d{0,19})$/).refine(value => (
  BigInt(value) <= 18_446_744_073_709_551_615n
), 'must fit in an unsigned 64-bit integer');

const agentMetadataSchema = z.object({
  hostName: boundedSafeText(255),
  platform: z.enum(['macos', 'windows', 'linux']),
  osVersion: boundedSafeText(64),
  agentVersion: boundedSafeText(64),
}).strict();

const agentObservationSchema = z.object({
  observationId: z.string().uuid(),
  networkProtocol: z.enum(['tcp', 'udp']),
  localAddress: ipLiteral,
  localPort: port,
  remoteAddress: ipLiteral,
  remotePort: port,
  processID: z.number().int().min(0).max(2_147_483_647),
  processName: boundedSafeText(256),
  bundleID: nullableBoundedSafeText(255),
  firstObservedAt: isoTimestamp,
  lastObservedAt: isoTimestamp,
  bytesIn: uint64Decimal.nullable(),
  bytesOut: uint64Decimal.nullable(),
  collector: z.enum(['network-extension', 'libproc']),
  confidence: z.enum(['exact', 'sampled']),
}).strict().superRefine((observation, ctx) => {
  if (Date.parse(observation.firstObservedAt) > Date.parse(observation.lastObservedAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['lastObservedAt'],
      message: 'must not be earlier than firstObservedAt',
    });
  }
});

function supportedSchemaVersionSchema() {
  const options = AGENT_INGEST_SUPPORTED_SCHEMA_VERSIONS.map(version => z.literal(version));
  return options.length === 1 ? options[0] : z.union(options);
}

const agentIngestEnvelopeSchema = z.object({
  // Accepts any supported version rather than only the newest, so an agent one
  // release behind keeps delivering instead of failing closed. A union needs
  // two members, and today there is only one version.
  schemaVersion: supportedSchemaVersionSchema(),
  batchId: z.string().uuid(),
  sentAt: isoTimestamp,
  agent: agentMetadataSchema,
  observations: z.array(agentObservationSchema).min(1).max(AGENT_INGEST_MAX_OBSERVATIONS),
}).strict();

function validateAgentObservationWindow(envelope, {
  now = Date.now(),
  retentionMs = AGENT_INGEST_DEFAULT_RETENTION_MS,
  maxFutureMs = AGENT_INGEST_MAX_FUTURE_MS,
} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0
      || !Number.isFinite(maxFutureMs) || maxFutureMs < 0) {
    throw new TypeError('invalid agent observation window options');
  }

  const oldestAllowed = now - retentionMs;
  const newestAllowed = now + maxFutureMs;
  const rejected = [];
  envelope.observations.forEach((observation, index) => {
    const first = Date.parse(observation.firstObservedAt);
    const last = Date.parse(observation.lastObservedAt);
    if (last < oldestAllowed) rejected.push({ index, reason: 'outside_retention' });
    if (first > newestAllowed || last > newestAllowed) rejected.push({ index, reason: 'future_timestamp' });
  });
  return rejected;
}

module.exports = {
  AGENT_INGEST_SCHEMA_VERSION,
  AGENT_INGEST_SUPPORTED_SCHEMA_VERSIONS,
  AGENT_INGEST_MAX_OBSERVATIONS,
  AGENT_INGEST_MAX_BODY_BYTES,
  AGENT_INGEST_DEFAULT_RETENTION_MS,
  AGENT_INGEST_MAX_FUTURE_MS,
  agentMetadataSchema,
  agentObservationSchema,
  agentIngestEnvelopeSchema,
  validateAgentObservationWindow,
};
