'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AGENT_INGEST_MAX_OBSERVATIONS,
  agentIngestEnvelopeSchema,
  validateAgentObservationWindow,
} = require('../../src/agent-ingest-schema');

const fixturePath = path.join(__dirname, '../../protocol/agent-ingest/v1/golden.json');
const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function copy(value = golden) {
  return structuredClone(value);
}

describe('agent ingest v1 schema', () => {
  it('accepts the shared golden payload without losing uint64 byte counts', () => {
    const result = agentIngestEnvelopeSchema.parse(copy());
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.agent.hostName, 'macbook-air');
    assert.equal(result.observations[0].bytesIn, '9007199254740993');
  });

  it('rejects unknown envelope and observation fields', () => {
    const envelope = copy();
    envelope.secret = 'must-not-pass';
    assert.equal(agentIngestEnvelopeSchema.safeParse(envelope).success, false);

    const observation = copy();
    observation.observations[0].commandLine = 'cat private.txt';
    assert.equal(agentIngestEnvelopeSchema.safeParse(observation).success, false);
  });

  it('rejects unsupported versions, host control characters, and malformed IPs', () => {
    const version = copy();
    version.schemaVersion = 2;
    assert.equal(agentIngestEnvelopeSchema.safeParse(version).success, false);

    const host = copy();
    host.agent.hostName = 'macbook\nforged-log';
    assert.equal(agentIngestEnvelopeSchema.safeParse(host).success, false);

    const address = copy();
    address.observations[0].remoteAddress = 'example.com';
    assert.equal(agentIngestEnvelopeSchema.safeParse(address).success, false);
  });

  it('rejects invalid ports, time order, and uint64 values', () => {
    const port = copy();
    port.observations[0].localPort = 0;
    assert.equal(agentIngestEnvelopeSchema.safeParse(port).success, false);

    const time = copy();
    time.observations[0].lastObservedAt = '2026-08-11T11:59:57Z';
    assert.equal(agentIngestEnvelopeSchema.safeParse(time).success, false);

    const calendar = copy();
    calendar.observations[0].lastObservedAt = '2026-02-30T12:00:00Z';
    assert.equal(agentIngestEnvelopeSchema.safeParse(calendar).success, false);

    const bytes = copy();
    bytes.observations[0].bytesIn = '18446744073709551616';
    assert.equal(agentIngestEnvelopeSchema.safeParse(bytes).success, false);
  });

  it('enforces the bounded non-empty batch size', () => {
    const empty = copy();
    empty.observations = [];
    assert.equal(agentIngestEnvelopeSchema.safeParse(empty).success, false);

    const oversized = copy();
    oversized.observations = Array.from(
      { length: AGENT_INGEST_MAX_OBSERVATIONS + 1 },
      (_, index) => ({
        ...copy().observations[0],
        observationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })
    );
    assert.equal(agentIngestEnvelopeSchema.safeParse(oversized).success, false);
  });

  it('reports observations outside retention or too far in the future', () => {
    const parsed = agentIngestEnvelopeSchema.parse(copy());
    assert.deepEqual(validateAgentObservationWindow(parsed, {
      now: Date.parse('2026-08-11T12:00:00Z'),
    }), []);

    assert.deepEqual(validateAgentObservationWindow(parsed, {
      now: Date.parse('2026-08-20T12:00:00Z'),
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    }), [{ index: 0, reason: 'outside_retention' }]);

    assert.deepEqual(validateAgentObservationWindow(parsed, {
      now: Date.parse('2026-08-09T12:00:00Z'),
      maxFutureMs: 24 * 60 * 60 * 1000,
    }), [{ index: 0, reason: 'future_timestamp' }]);
  });
});
