'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AGENT_INGEST_MAX_OBSERVATIONS,
  AGENT_INGEST_OPTIONAL_OBSERVATION_FIELDS,
  agentIngestEnvelopeSchema,
  agentObservationSchema,
  screenAgentObservationWindow,
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

  it('accepts Windows ETW observations', () => {
    const windows = copy();
    windows.agent.platform = 'windows';
    windows.agent.hostName = 'desktop-01';
    windows.observations[0].collector = 'etw';
    windows.observations[0].bundleID = null;
    assert.equal(agentIngestEnvelopeSchema.safeParse(windows).success, true);
  });

  it('rejects unknown envelope and observation fields', () => {
    const envelope = copy();
    envelope.unexpectedField = 'must-not-pass';
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

  it('accepts an unknown local port but rejects invalid remote ports, time order, and uint64 values', () => {
    const unknownLocalPort = copy();
    unknownLocalPort.observations[0].localPort = 0;
    assert.equal(agentIngestEnvelopeSchema.safeParse(unknownLocalPort).success, true);

    const remotePort = copy();
    remotePort.observations[0].remotePort = 0;
    assert.equal(agentIngestEnvelopeSchema.safeParse(remotePort).success, false);

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

  it('未来の時刻は拒否し、保持期間より古い観測は除く', () => {
    const parsed = agentIngestEnvelopeSchema.parse(copy());
    const week = 7 * 24 * 60 * 60 * 1000;
    assert.deepEqual(screenAgentObservationWindow(parsed, {
      now: Date.parse('2026-08-11T12:00:00Z'),
    }), { rejected: [], expired: [] });

    assert.deepEqual(screenAgentObservationWindow(parsed, {
      now: Date.parse('2026-08-09T12:00:00Z'),
      maxFutureMs: 24 * 60 * 60 * 1000,
    }), { rejected: [{ index: 0, reason: 'future_timestamp' }], expired: [] });

    // Sent now, after a week away: the old observation is left out and the
    // batch goes through.
    const late = copy();
    late.sentAt = '2026-08-20T12:00:00Z';
    assert.deepEqual(screenAgentObservationWindow(agentIngestEnvelopeSchema.parse(late), {
      now: Date.parse('2026-08-20T12:00:00Z'),
      retentionMs: week,
    }), { rejected: [], expired: [0] });
  });

  it('送信時刻まで保持期間より古いバッチは、時計の狂いとして拒否する', () => {
    // The golden batch says it was sent on 08-11; the Hub thinks it is
    // 08-20. Leaving its observations out would lose everything this Agent
    // sends without a word, so the batch is refused as before.
    const parsed = agentIngestEnvelopeSchema.parse(copy());
    assert.deepEqual(screenAgentObservationWindow(parsed, {
      now: Date.parse('2026-08-20T12:00:00Z'),
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    }), { rejected: [{ index: 0, reason: 'outside_retention' }], expired: [] });
  });
});

// P3-14 stage 2. The agent looks for this exact string in the capabilities
// answer; a rename on either side silently stops the field being sent.
describe('観測に付いてくる宛先名', () => {
  const base = () => structuredClone(golden.observations[0]);

  it('正しい名前を受け入れる', () => {
    const parsed = agentObservationSchema.safeParse({ ...base(), remoteHostname: 'api.example.com' });
    assert.equal(parsed.success, true);
  });

  it('省略とnullは同じく受け入れる', () => {
    assert.equal(agentObservationSchema.safeParse(base()).success, true);
    assert.equal(agentObservationSchema.safeParse({ ...base(), remoteHostname: null }).success, true);
  });

  it('空白を含む名前と長すぎる名前は拒否する', () => {
    // The agent drops these rather than storing them; a Hub must not be more
    // trusting of its input than the agent that sent it was.
    assert.equal(agentObservationSchema.safeParse({ ...base(), remoteHostname: 'bad name.com' }).success, false);
    assert.equal(agentObservationSchema.safeParse({ ...base(), remoteHostname: 'a'.repeat(254) }).success, false);
  });

  it('Agentが探す名前をそのまま公開している', () => {
    assert.deepEqual([...AGENT_INGEST_OPTIONAL_OBSERVATION_FIELDS], ['remoteHostname']);
  });
});
