'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const agentRoutes = require('../../src/routes/agents');
const agentIdentities = require('../../src/agent-identities');
const agentIngestStore = require('../../src/agent-ingest-store');

const golden = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../protocol/agent-ingest/v1/golden.json'),
  'utf8'
));

const metadata = {
  hostName: 'route-test-mac',
  platform: 'macos',
  osVersion: '26.5.2',
  agentVersion: '0.1.13',
};

beforeEach(() => {
  agentIdentities._initForTest();
  agentIngestStore._initForTest();
});
after(() => {
  agentIdentities.closeDb();
  agentIngestStore.closeDb();
});

function makeApp({
  agentIngest = agentIngestStore,
  allowPlaintext = false,
  recordConnections = null,
  relocateAgentConnection = null,
  queueConnectionEnrichment = null,
  threatIntel = null,
  ingestAuditSummary = null,
  onInboundProbes = null,
  devices = null,
} = {}) {
  const audits = [];
  const app = express();
  app.use(express.json());
  const requireAdmin = (req, _res, next) => {
    req.authMethod = 'local';
    req.actor = 'session:1';
    req.principal = 'local:admin';
    next();
  };
  const requireAgent = (req, res, next) => {
    const token = String(req.get('Authorization') || '').replace(/^Bearer /, '');
    const identity = agentIdentities.verifyAgentToken(token);
    if (!identity) return res.status(401).json({ error: 'Agent authentication failed' });
    req.agentIdentity = identity;
    req.authMethod = 'agent-token';
    req.actor = `agent:${identity.agentId}`;
    req.principal = `agent:${identity.agentId}`;
    next();
  };
  app.use('/api', agentRoutes({
    requireAdmin,
    requireAgent,
    agentIdentities,
    agentIngest,
    recordConnections,
    relocateAgentConnection,
    queueConnectionEnrichment,
    threatIntel,
    isPlaintextAllowed: () => allowPlaintext,
    authAudit: { append: event => audits.push(event) },
    ingestAuditSummary,
    onInboundProbes,
    devices,
  }));
  return { app, audits };
}

function ingestEnvelope() {
  const envelope = structuredClone(golden);
  const now = Date.now();
  envelope.sentAt = new Date(now).toISOString();
  envelope.observations[0].firstObservedAt = new Date(now - 1000).toISOString();
  envelope.observations[0].lastObservedAt = new Date(now).toISOString();
  return envelope;
}

function request(app, method, url, { body = null, headers = {}, localAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({ read() { if (payload) this.push(payload); this.push(null); } });
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
    );
    Object.defineProperty(req, 'ip', { value: '198.51.100.20', configurable: true });
    if (payload) {
      req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(payload.length);
    }
    req._destroy = (error, done) => done(error);
    const res = new http.ServerResponse(req);
    const chunks = [];
    const socket = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    Object.defineProperty(socket, 'localAddress', { value: localAddress });
    req.connection = socket;
    req.socket = socket;
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      resolve({ status: res.statusCode, body: parsed, raw });
    });
    app.handle(req, res, reject);
  });
}

/** Issue a code, apply with it, approve, then collect the token. */
async function enrolledAgent(app) {
  const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
  const applied = await request(app, 'POST', '/api/agent/enrollment-requests', {
    body: { code: issued.body.code, agent: metadata },
  });
  await request(app, 'POST', `/api/agents/enrollment-requests/${applied.body.requestId}/approve`, { body: {} });
  const enrolled = await request(app, 'POST', '/api/agent/enrollment-requests/claim', {
    body: { requestId: applied.body.requestId, claimSecret: applied.body.claimSecret },
  });
  return { issued, applied, enrolled };
}

describe('Agent HTTP enrollment', () => {
  it('三段階で登録が完了し、平文の値をどこにも残さない', async () => {
    const { app, audits } = makeApp();
    const { issued, enrolled } = await enrolledAgent(app);
    assert.equal(issued.status, 201);
    assert.match(issued.body.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    assert.equal(enrolled.status, 201);
    assert.match(enrolled.body.token, /^egva_/);

    const listed = await request(app, 'GET', '/api/agents');
    assert.equal(listed.body.agents.length, 1);
    const serialized = JSON.stringify(listed.body);
    assert.equal(serialized.includes(issued.body.code), false);
    assert.equal(serialized.includes(enrolled.body.token), false);
    assert.equal(serialized.includes('tokenHash'), false);

    const auditJson = JSON.stringify(audits);
    assert.equal(auditJson.includes(issued.body.code), false);
    assert.equal(auditJson.includes(enrolled.body.token), false);
    assert.equal(auditJson.includes(metadata.hostName), false);
  });

  it('申請だけではagentが作られず、tokenも返らない', async () => {
    const { app } = makeApp();
    const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
    const applied = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: issued.body.code, agent: metadata },
    });
    assert.equal(applied.status, 202);
    assert.equal(applied.body.status, 'pending');
    assert.equal(Object.hasOwn(applied.body, 'token'), false);
    // 承認前にagentが生えないことが本方式の核心。
    assert.deepEqual((await request(app, 'GET', '/api/agents')).body.agents, []);
  });

  it('承認は管理者しか実行できず、承認応答にtokenを含めない', async () => {
    const { app } = makeApp();
    const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
    const applied = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: issued.body.code, agent: metadata },
    });
    const pending = await request(app, 'GET', '/api/agents/enrollment-requests');
    assert.equal(pending.body.requests.length, 1);
    assert.equal(pending.body.requests[0].hostName, metadata.hostName);

    const approved = await request(app, 'POST', `/api/agents/enrollment-requests/${applied.body.requestId}/approve`, { body: {} });
    assert.equal(approved.status, 200);
    // 承認者の画面に生きたcredentialを置かない。tokenはAgentだけが取りに来る。
    assert.equal(JSON.stringify(approved.body).includes('egva_'), false);
  });

  it('却下された申請はtokenを渡さない', async () => {
    const { app } = makeApp();
    const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
    const applied = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: issued.body.code, agent: metadata },
    });
    await request(app, 'POST', `/api/agents/enrollment-requests/${applied.body.requestId}/reject`, { body: {} });
    const claimed = await request(app, 'POST', '/api/agent/enrollment-requests/claim', {
      body: { requestId: applied.body.requestId, claimSecret: applied.body.claimSecret },
    });
    assert.equal(claimed.body.status, 'rejected');
    assert.deepEqual(agentIdentities.listAgents(), []);
  });

  it('未知のフィールドや禁止メタデータを保存前に弾く', async () => {
    const { app } = makeApp();
    const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
    const invalid = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: issued.body.code, agent: { ...metadata, commandLine: 'private-command' } },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(agentIdentities.listAgents(), []);
  });

  it('誤ったcodeの連続試行をrate limitで止める', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 5; i++) {
      const failed = await request(app, 'POST', '/api/agent/enrollment-requests', {
        body: { code: 'ZZZZZ' + String.fromCharCode(50 + i), agent: metadata },
      });
      assert.equal(failed.status, 401);
    }
    const limited = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: 'ZZZZZZ', agent: metadata },
    });
    assert.equal(limited.status, 429);
  });

  it('承諾していない平文HTTPは、loopback以外で拒否する', async () => {
    const { app } = makeApp();
    const rejected = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: 'ZZZZZZ', agent: metadata },
      localAddress: '192.168.1.20',
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /Unencrypted/);
  });

  it('承諾済みなら平文HTTPでも受け付ける', async () => {
    // 家庭LANでTLSを立てられない運用者のための逃げ道。露出内容を設定画面で
    // 示したうえで選ばせる、という判断がここに現れている。
    const { app } = makeApp({ allowPlaintext: true });
    const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
    const applied = await request(app, 'POST', '/api/agent/enrollment-requests', {
      body: { code: issued.body.code, agent: metadata },
      localAddress: '192.168.1.20',
    });
    assert.equal(applied.status, 202);
  });
});

describe('Agent HTTP credential lifecycle', () => {
  it('rotates through Agent bearer auth and invalidates the old credential', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const rotated = await request(app, 'POST', '/api/agent/token/rotate', {
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(rotated.status, 200);
    assert.match(rotated.body.token, /^egva_/);
    assert.equal(agentIdentities.verifyAgentToken(enrolled.body.token), null);
    assert.ok(agentIdentities.verifyAgentToken(rotated.body.token));
  });

  it('revokes one Agent and denies its bearer without deleting its record', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const id = enrolled.body.agentId;
    const revoked = await request(app, 'POST', `/api/agents/${id}/revoke`);
    assert.equal(revoked.status, 200);
    assert.equal(agentIdentities.verifyAgentToken(enrolled.body.token), null);
    assert.equal(agentIdentities.listAgents()[0].agentId, id);
    assert.equal(typeof agentIdentities.listAgents()[0].revokedAt, 'number');
  });

  it('lets an Agent revoke only its own registration', async () => {
    const { app, audits } = makeApp();
    const first = await enrolledAgent(app);
    const second = await enrolledAgent(app);
    const response = await request(app, 'POST', '/api/agent/registration/revoke', {
      headers: { Authorization: `Bearer ${first.enrolled.body.token}` },
    });

    assert.equal(response.status, 200);
    assert.equal(agentIdentities.verifyAgentToken(first.enrolled.body.token), null);
    assert.ok(agentIdentities.verifyAgentToken(second.enrolled.body.token));
    assert.equal(audits.at(-1).eventType, 'agent_self_revoked');
    assert.equal(audits.at(-1).outcome, 'success');
  });
});

describe('Agent HTTP ingest', () => {
  // P3-185: the opening report did not know the local address and the
  // connection row was keyed on 0.0.0.0; the closing report names it.
  it('終了時の報告で送信元が分かったら、接続の行の付け替えを頼む', async () => {
    const moves = [];
    const { app } = makeApp({
      recordConnections: () => {},
      relocateAgentConnection: move => moves.push(move),
    });
    const { enrolled } = await enrolledAgent(app);
    const headers = { Authorization: `Bearer ${enrolled.body.token}` };
    const opening = ingestEnvelope();
    Object.assign(opening.observations[0], { localAddress: '0.0.0.0', localPort: 0, bytesIn: null, bytesOut: null });
    opening.observations = [opening.observations[0]];
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: opening, headers })).status, 200);
    assert.deepEqual(moves, []);

    const closing = structuredClone(opening);
    closing.batchId = '00000000-0000-4000-8000-0000000000aa';
    Object.assign(closing.observations[0], { localAddress: '192.0.2.10', localPort: 49152, bytesIn: '700', bytesOut: '148' });
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: closing, headers })).status, 200);

    const observation = closing.observations[0];
    assert.deepEqual(moves, [{
      fromSrc: '0.0.0.0', toSrc: '192.0.2.10', toSport: 49152,
      dst: observation.remoteAddress, dport: observation.remotePort, proto: observation.networkProtocol,
      agentHost: closing.agent.hostName,
    }]);
  });

  it('queues only public Agent destinations for enrichment once', async () => {
    const recorded = [];
    const queued = [];
    const { app } = makeApp({
      recordConnections: (...args) => recorded.push(args),
      queueConnectionEnrichment: destinations => queued.push(destinations),
    });
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const template = envelope.observations[0];
    const destinations = [
      '8.8.8.8',
      '2606:4700:4700::1111',
      '192.168.1.20',
      '127.0.0.1',
      '169.254.169.254',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
    ];
    envelope.observations = destinations.map((remoteAddress, index) => ({
      ...template,
      observationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      localAddress: '::',
      remoteAddress,
      localPort: index === 0 ? 0 : template.localPort,
    }));
    const headers = { Authorization: `Bearer ${enrolled.body.token}` };

    const first = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
    assert.equal(first.status, 200);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0].length, destinations.length);
    assert.equal(recorded[0][0][0].sport, null);
    assert.equal(recorded[0][0][0].src, '::');
    assert.equal(recorded[0][0][0].process, template.processName);
    assert.equal(recorded[0][0][0].pid, template.processID);
    assert.equal(recorded[0][0][1].sport, template.localPort);
    assert.deepEqual(queued, [['8.8.8.8', '2606:4700:4700::1111']]);

    const replay = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(recorded.length, 1);
    assert.equal(queued.length, 1);
  });

  it('stores a valid batch and returns a stable ACK on replay', async () => {
    const { app, audits } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const headers = { Authorization: `Bearer ${enrolled.body.token}` };

    const first = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
    assert.equal(first.status, 200);
    assert.equal(first.body.accepted, 1);
    assert.equal(first.body.duplicate, 0);
    assert.equal(first.body.replayed, false);

    const replay = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
    assert.equal(replay.status, 200);
    assert.deepEqual(
      { ...replay.body, replayed: false },
      first.body
    );
    assert.equal(replay.body.replayed, true);
    assert.equal(agentIngestStore._dbForTest()
      .prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 1);

    const auditJson = JSON.stringify(audits);
    assert.equal(auditJson.includes(envelope.agent.hostName), false);
    assert.equal(auditJson.includes(envelope.observations[0].processName), false);
    assert.equal(auditJson.includes(enrolled.body.token), false);
  });

  it('accepts a Windows ETW payload through the HTTP and DB contract', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    envelope.agent.platform = 'windows';
    envelope.observations[0].collector = 'etw';

    const response = await request(app, 'POST', '/api/agent/ingest', {
      body: envelope,
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.accepted, 1);
    assert.equal(response.body.duplicate, 0);
    assert.equal(response.body.rejected, 0);
    assert.equal(agentIngestStore._dbForTest().prepare(
      'SELECT collector FROM agent_observations'
    ).get().collector, 'etw');
  });

  it('ingests in an offline/private profile without making outbound requests', async () => {
    const originalFetch = global.fetch;
    let outboundCalls = 0;
    global.fetch = async () => {
      outboundCalls += 1;
      throw new Error('outbound request is prohibited');
    };
    try {
      const { app } = makeApp();
      const { enrolled } = await enrolledAgent(app);
      const response = await request(app, 'POST', '/api/agent/ingest', {
        body: ingestEnvelope(),
        headers: { Authorization: `Bearer ${enrolled.body.token}` },
        localAddress: '127.0.0.1',
      });
      assert.equal(response.status, 200);
      assert.equal(outboundCalls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects unauthenticated, future, and unknown-schema batches without writes', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();

    const anonymous = await request(app, 'POST', '/api/agent/ingest', { body: envelope });
    assert.equal(anonymous.status, 401);

    const future = structuredClone(envelope);
    const futureTime = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    future.observations[0].firstObservedAt = futureTime;
    future.observations[0].lastObservedAt = futureTime;
    const futureResponse = await request(app, 'POST', '/api/agent/ingest', {
      body: future,
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(futureResponse.status, 422);

    const unknown = structuredClone(envelope);
    unknown.schemaVersion = 2;
    const unknownResponse = await request(app, 'POST', '/api/agent/ingest', {
      body: unknown,
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(unknownResponse.status, 400);
    // Named, not a generic validation failure: an agent must be able to tell
    // "this Hub is older than what I speak" from "my payload was malformed",
    // because only the first one is worth telling the user about.
    assert.equal(unknownResponse.body.error, 'unsupported_schema_version');
    assert.equal(unknownResponse.body.requested, 2);
    assert.deepEqual(unknownResponse.body.supported, [1]);
    assert.match(unknownResponse.body.hint, /Update the EgressView Hub/);
    assert.equal(agentIngestStore._dbForTest()
      .prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
  });

  it('1週間以上前の観測だけを除き、残りを受け取って配布済みAgentが次へ進める応答を返す', async () => {
    const { app, audits } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const envelope = ingestEnvelope();
    const old = structuredClone(envelope.observations[0]);
    old.observationId = '00000000-0000-4000-8000-0000000000aa';
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    old.firstObservedAt = new Date(oldTime - 1000).toISOString();
    old.lastObservedAt = new Date(oldTime).toISOString();
    envelope.observations.push(old);

    const response = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization });
    assert.equal(response.status, 200);
    // What every released Agent checks before it lets a batch go: nothing
    // rejected, and accepted + duplicate covering the batch.
    assert.equal(response.body.rejected, 0);
    assert.equal(response.body.accepted, 1);
    assert.equal(response.body.duplicate, 1);
    assert.equal(response.body.expired, 1);
    assert.equal(response.body.accepted + response.body.duplicate, envelope.observations.length);
    const ids = agentIngestStore._dbForTest()
      .prepare('SELECT observationId FROM agent_observations').all().map(row => row.observationId);
    assert.deepEqual(ids, [envelope.observations[0].observationId]);
    const expiredAudit = audits.find(event => event.metadata?.reason === 'observation_expired');
    assert.equal(expiredAudit?.outcome, 'success');
    assert.equal(expiredAudit.metadata.expiredCount, 1);

    // Sent again (the reply was lost): the stored counts still cover it.
    const replay = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.rejected, 0);
    assert.equal(replay.body.accepted + replay.body.duplicate, envelope.observations.length);
  });

  it('全部が古い観測でも受け取り済みとして返し、バッチを完了として記録する', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const oldTime = Date.now() - 9 * 24 * 60 * 60 * 1000;
    envelope.observations[0].firstObservedAt = new Date(oldTime - 1000).toISOString();
    envelope.observations[0].lastObservedAt = new Date(oldTime).toISOString();

    const response = await request(app, 'POST', '/api/agent/ingest', {
      body: envelope,
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      [response.body.accepted, response.body.duplicate, response.body.rejected, response.body.expired],
      [0, 1, 0, 1]
    );
    const db = agentIngestStore._dbForTest();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
    // Recorded complete, so a resend is answered as a replay and the Agent's
    // details are updated as for any delivered batch.
    assert.deepEqual(
      db.prepare('SELECT acceptedCount, duplicateCount, rejectedCount FROM agent_ingest_batches').get(),
      { acceptedCount: 0, duplicateCount: 1, rejectedCount: 0 }
    );
  });

  it('送信時刻まで1週間以上前のバッチは、時計の狂いとして今までどおり422で断る', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    envelope.sentAt = new Date(oldTime).toISOString();
    envelope.observations[0].firstObservedAt = new Date(oldTime - 1000).toISOString();
    envelope.observations[0].lastObservedAt = new Date(oldTime).toISOString();

    const response = await request(app, 'POST', '/api/agent/ingest', {
      body: envelope,
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.status, 422);
    assert.deepEqual(response.body.rejected, [{ index: 0, reason: 'outside_retention' }]);
    assert.equal(agentIngestStore._dbForTest()
      .prepare('SELECT COUNT(*) AS n FROM agent_observations').get().n, 0);
  });

  it('capabilityを返し、配布済みAgentの送信を変えない', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };

    const capabilities = await request(app, 'GET', '/api/agent/capabilities', { headers: authorization });
    assert.equal(capabilities.status, 200);
    assert.deepEqual(capabilities.body.schemaVersions, [1]);
    assert.equal(capabilities.body.maxObservationsPerBatch, 200);
    // The exact string the agent looks for before it will send the field. A
    // rename here stops the name being sent and says nothing (P3-14 stage 2).
    assert.deepEqual(capabilities.body.observationFields, ['remoteHostname']);
    // An agent reuses an observation id for a flow's closing report only when
    // this is true; a Hub without it would drop the counts as a duplicate (P3-170).
    assert.equal(capabilities.body.observationUpdates, true);
    assert.equal(capabilities.body.unmeasuredClosings, true);
    assert.equal(capabilities.body.maxBodyBytes, 512 * 1024);
    // Declared empty rather than omitted, so an agent cannot read a missing
    // field as permission to compress.
    assert.deepEqual(capabilities.body.compression, []);

    // The agents already in the field never call the endpoint above and send
    // version 1 unconditionally. That has to keep working exactly as before.
    const accepted = await request(app, 'POST', '/api/agent/ingest', {
      body: envelope,
      headers: authorization,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.accepted, envelope.observations.length);
  });

  it('geoキャッシュを全件返し、Agentに宛先を尋ねさせない', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const db = agentIngestStore._dbForTest();
    db.exec('CREATE TABLE IF NOT EXISTS geo_cache (ip TEXT PRIMARY KEY, lat REAL, lon REAL, city TEXT, countryCode TEXT, expires INTEGER)');
    db.prepare(
      'INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires) VALUES (?,?,?,?,?,?)'
    ).run('203.0.113.5', 35.6, 139.7, 'Tokyo', 'JP', Date.now() + 86_400_000);
    db.prepare(
      'INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires) VALUES (?,?,?,?,?,?)'
    ).run('198.51.100.9', null, null, null, null, Date.now() + 86_400_000);

    const response = await request(app, 'GET', '/api/agent/geo-cache', { headers: authorization });
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, 1);
    // Rows without coordinates are left out: they cannot be put on a map, so
    // sending them is pure transfer.
    assert.deepEqual(response.body.entries, [['203.0.113.5', 35.6, 139.7, 'JP', 'Tokyo']]);
  });

  it('geoキャッシュは変化が無ければ304を返す', async () => {
    // The cache moves by a handful of rows a day. Re-sending megabytes for that
    // would be the whole cost of the feature.
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const geoDb = agentIngestStore._dbForTest();
    geoDb.exec('CREATE TABLE IF NOT EXISTS geo_cache (ip TEXT PRIMARY KEY, lat REAL, lon REAL, city TEXT, countryCode TEXT, expires INTEGER)');
    geoDb.prepare(
      'INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires) VALUES (?,?,?,?,?,?)'
    ).run('203.0.113.5', 35.6, 139.7, 'Tokyo', 'JP', Date.now() + 86_400_000);

    const first = await request(app, 'GET', '/api/agent/geo-cache', { headers: authorization });
    const etag = /^etag: (.+)$/im.exec(first.raw)?.[1]?.trim();
    assert.ok(etag, 'an ETag is required for the agent to avoid re-downloading');

    const second = await request(app, 'GET', '/api/agent/geo-cache', {
      headers: { ...authorization, 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
  });

  it('geoキャッシュの表が無いHubでも500にせず、空として返す', async () => {
    // enrichmentが一度も動いていないHubには表そのものが無い。**置くものが無い**
    // のであって障害ではなく、Agent側の地図はその状態を説明できる。
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const response = await request(app, 'GET', '/api/agent/geo-cache', {
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.entries, []);
  });

  it('脅威指標を全件返し、Agentは宛先を1件も送らない', async () => {
    // 「危ないか」を尋ねるために宛先を送ると、何を気にしているかを相手に伝える
    // ことになる。**それを避けるためのエンドポイント**なので、requestには
    // 宛先を入れさせない。
    const threatIntel = {
      listIndicators: () => ({
        ips: [['203.0.113.7', 'feodo', 'Dridex C2']],
        domains: [['bad.example', 'urlhaus', 'malware download']],
        cidrs: [['198.51.100.0/24', 'spamhaus', 'Spamhaus DROP (hijacked network)']],
        lastFetch: 1_700_000_000_000,
      }),
    };
    const { app } = makeApp({ threatIntel });
    const { enrolled } = await enrolledAgent(app);

    const response = await request(app, 'GET', '/api/agent/threat-intel', {
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, 1);
    assert.equal(response.body.available, true);
    assert.deepEqual(response.body.ips, [['203.0.113.7', 'feodo', 'Dridex C2']]);
    assert.deepEqual(response.body.domains, [['bad.example', 'urlhaus', 'malware download']]);
    assert.deepEqual(response.body.cidrs, [
      ['198.51.100.0/24', 'spamhaus', 'Spamhaus DROP (hijacked network)'],
    ]);
  });

  it('脅威指標は変化が無ければ304を返す', async () => {
    const threatIntel = {
      listIndicators: () => ({
        ips: [['203.0.113.7', 'feodo', 'Dridex C2']],
        domains: [],
        cidrs: [],
        lastFetch: 1_700_000_000_000,
      }),
    };
    const { app } = makeApp({ threatIntel });
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };

    const first = await request(app, 'GET', '/api/agent/threat-intel', { headers: authorization });
    const etag = /^etag: (.+)$/im.exec(first.raw)?.[1]?.trim();
    assert.ok(etag, '半メガバイトを毎回送り直さないためにETagが要る');

    const second = await request(app, 'GET', '/api/agent/threat-intel', {
      headers: { ...authorization, 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
  });

  it('フィードが無いHubは available:false を返し、脅威ゼロとは言わない', async () => {
    // 「脅威が見つからなかった」と「誰も調べていない」は別の事実である。
    // 前者として見せると、Agentは調べていない期間を安全な期間として表示する。
    const { app } = makeApp({ threatIntel: null });
    const { enrolled } = await enrolledAgent(app);
    const response = await request(app, 'GET', '/api/agent/threat-intel', {
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.available, false);
    assert.deepEqual(response.body.ips, []);
  });

  it('脅威指標は資格情報を要求する', async () => {
    const { app } = makeApp({ threatIntel: { listIndicators: () => ({ ips: [], domains: [], cidrs: [] }) } });
    const anonymous = await request(app, 'GET', '/api/agent/threat-intel');
    assert.equal(anonymous.status, 401);
  });

  it('geoキャッシュは資格情報を要求する', async () => {
    const { app } = makeApp();
    const anonymous = await request(app, 'GET', '/api/agent/geo-cache');
    assert.equal(anonymous.status, 401);
  });

  it('capabilityは資格情報を要求する', async () => {
    // 401 from a Hub that has the route, 404 from one that does not: together
    // they let an agent tell "not enrolled yet" from "this Hub is too old".
    const { app } = makeApp();
    const anonymous = await request(app, 'GET', '/api/agent/capabilities');
    assert.equal(anonymous.status, 401);
  });

  it('limits each Agent to 30 ingest requests per minute and exposes aggregate metrics', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const headers = { Authorization: `Bearer ${enrolled.body.token}` };
    for (let index = 0; index < 30; index += 1) {
      const response = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
      assert.equal(response.status, 200);
    }
    const limited = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
    assert.equal(limited.status, 429);
    assert.match(limited.raw, /Retry-After:/i);

    const metrics = await request(app, 'GET', '/api/agents/ingest-metrics');
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.requests, 31);
    assert.equal(metrics.body.rateLimited, 1);
    assert.equal(metrics.body.limits.maxConcurrent, 4);
    assert.equal(JSON.stringify(metrics.body).includes(envelope.agent.hostName), false);
  });

  it('limits global ingest concurrency to four without logging payload fields', async () => {
    const completions = [];
    const slowStore = {
      storeBatch(_agentId, envelope) {
        return new Promise(resolve => completions.push(() => resolve({
          batchId: envelope.batchId,
          accepted: envelope.observations.length,
          duplicate: 0,
          rejected: 0,
          receivedAt: Date.now(),
          replayed: false,
        })));
      },
    };
    const { app } = makeApp({ agentIngest: slowStore });
    const { enrolled } = await enrolledAgent(app);
    const headers = { Authorization: `Bearer ${enrolled.body.token}` };
    const pending = Array.from({ length: 4 }, (_value, index) => {
      const envelope = ingestEnvelope();
      envelope.batchId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      return request(app, 'POST', '/api/agent/ingest', { body: envelope, headers });
    });
    while (completions.length < 4) await new Promise(resolve => setImmediate(resolve));

    const busy = await request(app, 'POST', '/api/agent/ingest', {
      body: ingestEnvelope(),
      headers,
    });
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error, 'Agent ingest is busy');

    completions.forEach(complete => complete());
    const responses = await Promise.all(pending);
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
  });
});

// A routine upload that went through is counted into the agent's hour rather
// than written as its own audit row; anything else still is (P3-175).
describe('Agent送信の監査ログ', () => {
  it('成功した送信は1件ずつ書かず、1時間ごとの集計に回す', async () => {
    const recorded = [];
    const { app, audits } = makeApp({ ingestAuditSummary: { record: (who, upload) => recorded.push({ who, upload }) } });
    const { enrolled } = await enrolledAgent(app);
    const before = audits.length;
    const response = await request(app, 'POST', '/api/agent/ingest', {
      body: ingestEnvelope(), headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });

    assert.equal(response.status, 200);
    assert.equal(audits.slice(before).filter(event => event.eventType === 'agent_ingest').length, 0);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].who.principal, `agent:${enrolled.body.agentId}`);
    assert.equal(recorded[0].upload.observationCount, 1);
    assert.equal(recorded[0].upload.acceptedCount, 1);
  });

  it('断った送信は、今どおり1件ずつ書く', async () => {
    const recorded = [];
    const { app, audits } = makeApp({ ingestAuditSummary: { record: () => recorded.push(1) } });
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    envelope.schemaVersion = 99;
    await request(app, 'POST', '/api/agent/ingest', {
      body: envelope, headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });

    assert.equal(recorded.length, 0);
    const failures = audits.filter(event => event.eventType === 'agent_ingest' && event.outcome === 'failure');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].metadata.reason, 'unsupported_schema_version');
  });

  // Part of the upload could not be stored: that is not routine, and it is
  // written as its own failure row with the reason, never folded into a count.
  it('一部を保存できなかった送信は、集計に回さず1件の失敗として書く', async () => {
    const recorded = [];
    const partial = {
      ...agentIngestStore,
      storeBatch: async (_agentId, envelope) => Object.freeze({
        batchId: envelope.batchId, accepted: 0, duplicate: 0, rejected: envelope.observations.length,
        receivedAt: Date.now(), replayed: false,
      }),
    };
    const { app, audits } = makeApp({ agentIngest: partial, ingestAuditSummary: { record: () => recorded.push(1) } });
    const { enrolled } = await enrolledAgent(app);
    await request(app, 'POST', '/api/agent/ingest', {
      body: ingestEnvelope(), headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });

    assert.equal(recorded.length, 0);
    const failures = audits.filter(event => event.eventType === 'agent_ingest' && event.outcome === 'failure');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].metadata.reason, 'observation_rejected');
  });
});


// P3-190: every fetch read, hashed and serialised all 118,758 rows on the
// request thread (300-400 ms, about 25 times an hour), even for a 304.
describe('agent geo-cache is built once and kept', () => {
  it('数分のあいだは作り直さず、同じETagと中身を返す', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const db = agentIngestStore._dbForTest();
    db.exec('CREATE TABLE IF NOT EXISTS geo_cache (ip TEXT PRIMARY KEY, lat REAL, lon REAL, city TEXT, countryCode TEXT, expires INTEGER)');
    const insert = db.prepare('INSERT INTO geo_cache (ip, lat, lon, city, countryCode, expires) VALUES (?,?,?,?,?,?)');
    insert.run('203.0.113.7', 35.6, 139.7, 'Tokyo', 'JP', Date.now() + 86_400_000);
    const first = await request(app, 'GET', '/api/agent/geo-cache', { headers: authorization });
    insert.run('203.0.113.8', 34.7, 135.5, 'Osaka', 'JP', Date.now() + 86_400_000);
    const second = await request(app, 'GET', '/api/agent/geo-cache', { headers: authorization });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.entries, first.body.entries, 'built once, served again');
    assert.equal(/^etag: (.+)$/im.exec(second.raw)?.[1], /^etag: (.+)$/im.exec(first.raw)?.[1]);
  });

  it('読み取り用スレッドで作った応答は、この場で作った応答と同じ', () => {
    const { buildGeoCacheResponse, buildGeoCacheFromDb } = require('../../src/agent-geo-cache');
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE geo_cache (ip TEXT PRIMARY KEY, lat REAL, lon REAL, city TEXT, countryCode TEXT, expires INTEGER)');
    db.prepare('INSERT INTO geo_cache VALUES (?,?,?,?,?,?)').run('198.51.100.3', 1.5, 2.5, null, 'SG', 0);
    db.prepare('INSERT INTO geo_cache VALUES (?,?,?,?,?,?)').run('198.51.100.4', null, null, null, null, 0);
    const built = buildGeoCacheFromDb(db);
    const here = buildGeoCacheResponse([{ ip: '198.51.100.3', lat: 1.5, lon: 2.5, countryCode: 'SG', city: null }]);
    assert.equal(built.etag, here.etag);
    assert.deepEqual(JSON.parse(built.json).entries, [['198.51.100.3', 1.5, 2.5, 'SG', null]]);
    assert.equal(built.count, 1);
  });
});

// P3-194: sent bytes per application, counted as observations arrive, split
// into private addresses and everything else.
describe('sent bytes by application', () => {
  function observation(overrides = {}) {
    const now = Date.now();
    return {
      ...structuredClone(golden.observations[0]),
      firstObservedAt: new Date(now - 1000).toISOString(),
      lastObservedAt: new Date(now).toISOString(),
      bytesIn: '10',
      ...overrides,
    };
  }

  it('外へ送った量をアプリごとに、プライベートアドレス宛ては合計で返す。閉じたときに届いた量も一度だけ数える', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const opening = observation({
      observationId: '00000000-0000-4000-8000-0000000000b2', remoteAddress: '198.51.100.21', bytesIn: null, bytesOut: null,
    });
    const envelope = ingestEnvelope();
    envelope.observations = [
      observation({ observationId: '00000000-0000-4000-8000-0000000000b1', bytesOut: '5000' }),
      opening,
      observation({
        observationId: '00000000-0000-4000-8000-0000000000b3', remoteAddress: '192.168.1.5', remotePort: 445,
        processName: 'unknown', bundleID: null, bytesOut: '900000',
      }),
    ];
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization })).status, 200);
    // A retry of the same upload is a duplicate and adds nothing.
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization })).status, 200);

    const closing = ingestEnvelope();
    closing.batchId = '00000000-0000-4000-8000-0000000000c1';
    closing.observations = [{ ...opening, bytesIn: '20', bytesOut: '3000', lastObservedAt: new Date().toISOString() }];
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: closing, headers: authorization })).status, 200);

    const listed = await request(app, 'GET', '/api/agents/app-bytes');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.days, 1);
    assert.equal(typeof listed.body.startedAt, 'number');
    const [agent] = listed.body.agents;
    assert.equal(agent.agentId, enrolled.body.agentId);
    assert.equal(agent.flows, 3);
    assert.equal(agent.flowsWithBytes, 3);
    assert.deepEqual(agent.beyond, {
      bytesOut: 8000, totalApps: 1,
      apps: [{ appIdentity: 'com.example.app', processName: 'Example', bytesOut: 8000, flows: 2 }],
    });
    assert.deepEqual(agent.private, { bytesOut: 900000, unnamedBytesOut: 900000 });
    assert.equal((await request(app, 'GET', '/api/agents/app-bytes?days=7')).body.days, 7);
  });

  it('期間は1日か7日だけ受け付ける', async () => {
    const { app } = makeApp();
    assert.equal((await request(app, 'GET', '/api/agents/app-bytes?days=30')).status, 400);
    assert.equal((await request(app, 'GET', '/api/agents/app-bytes?agent=x')).status, 400);
  });
});

// P3-191: a device on the LAN probing a computer with an Agent. The summaries
// ride along with an upload, are stored, and the new ones go to the callback.
describe('inbound probe summaries', () => {
  function probe(overrides = {}) {
    const windowStart = new Date(Math.floor(Date.now() / 120000) * 120000).toISOString();
    return {
      windowStart, windowSeconds: 120, localAddress: '192.168.1.53', sourceAddress: '192.168.1.77',
      networkProtocol: 'tcp', distinctPorts: 25, packets: 60, samplePorts: [21, 22, 23, 80, 443], ...overrides,
    };
  }

  it('Hubは受け取れることを伝える', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const response = await request(app, 'GET', '/api/agent/capabilities', {
      headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.body.inboundProbes, true);
  });

  it('観測と一緒に届いた記録を保存し、新しいものだけ知らせる。再送では知らせない', async () => {
    const told = [];
    const { app } = makeApp({ onInboundProbes: report => told.push(report) });
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const envelope = ingestEnvelope();
    envelope.inboundProbes = [probe(), probe({ networkProtocol: 'udp', distinctPorts: 6, samplePorts: [53, 137] })];
    const first = await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization });
    assert.equal(first.status, 200);
    assert.equal(told.length, 1);
    assert.equal(told[0].probes.length, 2);
    assert.equal(told[0].probes[0].sourceAddress, '192.168.1.77');
    const rows = agentIngestStore._dbForTest().prepare('SELECT * FROM agent_inbound_probes ORDER BY networkProtocol').all();
    assert.equal(rows.length, 2);
    assert.deepEqual(JSON.parse(rows[0].samplePorts), [21, 22, 23, 80, 443]);

    const again = ingestEnvelope();
    again.batchId = '00000000-0000-4000-8000-0000000000aa';
    again.observations[0].observationId = '00000000-0000-4000-8000-0000000000ab';
    again.inboundProbes = [probe({ distinctPorts: 30 })];
    const second = await request(app, 'POST', '/api/agent/ingest', { body: again, headers: authorization });
    assert.equal(second.status, 200);
    assert.equal(told.length, 1, 'the same window counted further is stored, not reported again');
    assert.equal(agentIngestStore._dbForTest().prepare("SELECT distinctPorts FROM agent_inbound_probes WHERE networkProtocol = 'tcp'").get().distinctPorts, 30);
  });

  it('Agentごとに、検出ログと同じ基準（10ポート以上）を超えた送り元を新しい順に返す', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const now = Math.floor(Date.now() / 120000) * 120000;
    const at = ms => new Date(ms).toISOString();
    const envelope = ingestEnvelope();
    envelope.inboundProbes = [
      probe({ windowStart: at(now - 3_600_000), distinctPorts: 12, samplePorts: [22, 23] }),
      probe({ windowStart: at(now), distinctPorts: 40, samplePorts: [80, 443, 445] }),
      probe({ sourceAddress: '192.168.1.88', windowStart: at(now - 600_000), distinctPorts: 15 }),
      // Below the threshold: counted by the Agent, not reported by the Hub.
      probe({ sourceAddress: '192.168.1.99', distinctPorts: 6 }),
      // Older than 14 days.
      probe({ sourceAddress: '192.168.1.66', windowStart: at(now - 15 * 86_400_000) }),
    ];
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization })).status, 200);

    const listed = await request(app, 'GET', '/api/agents/inbound-probes');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.days, 14);
    assert.equal(listed.body.minPorts, 10);
    const [agent] = listed.body.agents;
    assert.equal(agent.agentId, enrolled.body.agentId);
    assert.equal(agent.total, 2);
    assert.deepEqual(agent.senders.map(sender => sender.sourceAddress), ['192.168.1.77', '192.168.1.88']);
    const [first] = agent.senders;
    assert.equal(first.windows, 2);
    assert.equal(first.maxPorts, 40);
    assert.equal(first.firstAt, now - 3_600_000);
    assert.equal(first.lastAt, now + 120_000);
    assert.deepEqual(first.samplePorts, [80, 443, 445], 'ports from the latest window');
    assert.equal(first.localAddress, '192.168.1.53');
  });

  it('取り消したAgentの記録は返さない', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    envelope.inboundProbes = [probe()];
    await request(app, 'POST', '/api/agent/ingest', {
      body: envelope, headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    await request(app, 'POST', `/api/agents/${enrolled.body.agentId}/revoke`);
    assert.deepEqual((await request(app, 'GET', '/api/agents/inbound-probes')).body.agents, []);
  });

  it('形の合わない記録は受け取らない', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    envelope.inboundProbes = [probe({ networkProtocol: 'icmp' })];
    const response = await request(app, 'POST', '/api/agent/ingest', {
      body: envelope, headers: { Authorization: `Bearer ${enrolled.body.token}` },
    });
    assert.equal(response.status, 400);
  });
});

// P3-194: what an Agent found worth a look and the person's answers, sent only
// when the person turned sharing on. Each send replaces that Agent's list.
describe('outbound candidates shared by an Agent', () => {
  const outboundCandidates = require('../../src/agent-outbound-candidates');

  function report(overrides = {}) {
    return {
      schemaVersion: 1,
      sharing: true,
      generatedAt: new Date().toISOString(),
      state: 'ready',
      total: 2,
      entries: [
        {
          candidateId: 'aboveUsual|2026-11-13|com.example.backup|example.net',
          kind: 'aboveUsual', day: '2026-11-13T00:00:00Z',
          application: 'com.example.backup', destination: 'example.net',
          bytesOut: 9_500_000_000, usualBytesOut: 400_000_000,
          answer: 'expected', answeredAt: '2026-11-14T01:00:00Z', note: '  自分のバックアップ  ',
        },
        {
          candidateId: 'newPair|2026-11-12|curl|example.org',
          kind: 'newPair', day: '2026-11-12T00:00:00Z',
          application: 'curl', destination: 'example.org', bytesOut: 120_000_000,
        },
      ],
      ...overrides,
    };
  }

  async function sharingAgent() {
    const made = makeApp();
    const { enrolled } = await enrolledAgent(made.app);
    return { ...made, enrolled, authorization: { Authorization: `Bearer ${enrolled.body.token}` } };
  }

  it('Hubは受け取れることを伝える', async () => {
    const { app, authorization } = await sharingAgent();
    const response = await request(app, 'GET', '/api/agent/capabilities', { headers: authorization });
    assert.equal(response.body.outboundCandidates, true);
    // An Agent sends more than 20 only when this says so; a Hub without it
    // refuses the whole list.
    assert.equal(response.body.maxOutboundCandidates, 150);
  });

  it('150件までの一覧を全部受け取り、151件は受け取らない', async () => {
    const { app, authorization } = await sharingAgent();
    const entries = count => Array.from({ length: count }, (_, index) => ({
      candidateId: `newPair|2026-11-${String(1 + (index % 14)).padStart(2, '0')}|app${index}|example.org`,
      kind: 'newPair', day: '2026-11-01T00:00:00Z',
      application: `com.example.app${index}`, destination: 'example.org', bytesOut: 2_000_000 + index,
    }));
    const full = await request(app, 'PUT', '/api/agent/outbound-candidates', {
      body: report({ total: 150, entries: entries(150) }), headers: authorization,
    });
    assert.equal(full.status, 200);
    assert.deepEqual(full.body, { stored: 150, sharing: true });
    const listed = await request(app, 'GET', '/api/agents/outbound-candidates');
    assert.equal(listed.body.agents[0].entries.length, 150);

    const over = await request(app, 'PUT', '/api/agent/outbound-candidates', {
      body: report({ total: 151, entries: entries(151) }), headers: authorization,
    });
    assert.equal(over.status, 400);
  });

  it('届いた一覧を登録名と一緒に管理者へ見せる。メモは前後の空白を落とす', async () => {
    const { app, authorization, enrolled } = await sharingAgent();
    const stored = await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.body, { stored: 2, sharing: true });

    const listed = await request(app, 'GET', '/api/agents/outbound-candidates');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.agents.length, 1);
    const [agent] = listed.body.agents;
    assert.equal(agent.agentId, enrolled.body.agentId);
    assert.equal(agent.hostName, metadata.hostName);
    assert.equal(agent.total, 2);
    assert.deepEqual(agent.entries.map(entry => entry.kind), ['aboveUsual', 'newPair']);
    assert.equal(agent.entries[0].answer, 'expected');
    assert.equal(agent.entries[0].note, '自分のバックアップ');
    assert.equal(agent.entries[1].answer, null);
    assert.equal(agent.entries[1].note, null);
  });

  it('送るたびに置き換える。消えた候補、取り消した答え、送らなくなったメモは残らない', async () => {
    const { app, authorization } = await sharingAgent();
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    const next = report({ total: 1 });
    next.entries = [{ ...next.entries[0], note: null }];
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: next, headers: authorization });
    const [agent] = (await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents;
    assert.equal(agent.entries.length, 1);
    assert.equal(agent.entries[0].note, null);
  });

  it('答えの無い候補にメモは付けない', async () => {
    const { app, authorization } = await sharingAgent();
    const body = report();
    body.entries[1].note = '答えずに書いたメモ';
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body, headers: authorization });
    const [agent] = (await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents;
    assert.equal(agent.entries[1].note, null);
  });

  it('送るのをやめると、そのAgentの分を消す', async () => {
    const { app, authorization } = await sharingAgent();
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    const off = await request(app, 'PUT', '/api/agent/outbound-candidates', {
      body: report({ sharing: false, total: 0, entries: [], state: null }), headers: authorization,
    });
    assert.deepEqual(off.body, { stored: 0, sharing: false });
    assert.deepEqual((await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents, []);
  });

  it('送るのをやめたのに中身があれば受け取らない', async () => {
    const { app, authorization } = await sharingAgent();
    const response = await request(app, 'PUT', '/api/agent/outbound-candidates', {
      body: report({ sharing: false }), headers: authorization,
    });
    assert.equal(response.status, 400);
  });

  it('知らない項目、長すぎるメモ、多すぎる候補は受け取らない', async () => {
    const { app, authorization } = await sharingAgent();
    const unknown = report();
    unknown.entries[0].processPath = '/Users/someone/bin/tool';
    const longNote = report();
    longNote.entries[0].note = 'あ'.repeat(outboundCandidates.NOTE_LIMIT + 1);
    const many = report();
    many.entries = Array.from({ length: outboundCandidates.MAX_ENTRIES + 1 }, (_, index) => ({
      ...many.entries[1], candidateId: `newPair|2026-11-12|curl|host${index}.example`,
    }));
    for (const body of [unknown, longNote, many]) {
      const response = await request(app, 'PUT', '/api/agent/outbound-candidates', { body, headers: authorization });
      assert.equal(response.status, 400);
    }
    assert.deepEqual((await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents, []);
  });

  it('上限いっぱいの一覧も、Hubが受け取るJSONの大きさに収まる', () => {
    const body = report();
    body.entries = Array.from({ length: outboundCandidates.MAX_ENTRIES }, (_, index) => ({
      candidateId: `${index}`.padEnd(600, 'x'), kind: 'aboveUsual', day: '2026-11-13T00:00:00Z',
      application: 'a'.repeat(255), destination: 'd'.repeat(255),
      bytesOut: Number.MAX_SAFE_INTEGER, usualBytesOut: Number.MAX_SAFE_INTEGER,
      answer: 'investigate', answeredAt: '2026-11-14T01:00:00.000Z', note: 'あ'.repeat(outboundCandidates.NOTE_LIMIT),
    }));
    assert.equal(outboundCandidates.outboundCandidatesSchema.safeParse(body).success, true);
    // Read after authentication at up to 512 KiB, as ingest is (http-app.js).
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 512 * 1024);
  });

  it('Mac Agentが作る見本をそのまま受け取る', async () => {
    const golden = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../protocol/agent-outbound-candidates/v1/golden.json'), 'utf8'
    ));
    const { app, authorization } = await sharingAgent();
    const response = await request(app, 'PUT', '/api/agent/outbound-candidates', { body: golden, headers: authorization });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { stored: 3, sharing: true });
  });

  it('Agentのトークンが無ければ受け取らない', async () => {
    const { app } = makeApp();
    const response = await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report() });
    assert.equal(response.status, 401);
  });

  it('登録を取り消したAgentの分は見せない', async () => {
    const { app, authorization, enrolled } = await sharingAgent();
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    await request(app, 'POST', `/api/agents/${enrolled.body.agentId}/revoke`, { body: {} });
    assert.deepEqual((await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents, []);
  });

  it('送られなくなった古い分は、期限を過ぎると片づく', async () => {
    const { app, authorization } = await sharingAgent();
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    const db = agentIngestStore._dbForTest();
    const later = Date.parse('2026-11-12T00:00:00Z') + outboundCandidates.RETENTION_MS + 1;
    const removed = outboundCandidates.pruneOutboundCandidates(db, { now: later });
    assert.equal(removed, 1);
    const [agent] = (await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents;
    assert.deepEqual(agent.entries.map(entry => entry.kind), ['aboveUsual']);
  });

  it('監査には件数だけを書き、アプリ名・宛先・メモは書かない', async () => {
    const { app, authorization, audits } = await sharingAgent();
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    const text = JSON.stringify(audits);
    for (const value of ['com.example.backup', 'example.net', 'バックアップ']) {
      assert.equal(text.includes(value), false, value);
    }
  });
});

describe('Hubで答え、Agentへ戻す（P3-194 段階2）', () => {
  const crypto = require('node:crypto');
  const hashed = id => crypto.createHash('sha256').update(id).digest('hex');
  const BACKUP = hashed('aboveUsual|2026-11-13|com.example.backup|example.net');
  const CURL = hashed('newPair|2026-11-12|curl|example.org');

  function report({ notesShared = true, backupAnsweredAt = '2026-11-14T01:00:00Z', backupAnswer = 'expected' } = {}) {
    return {
      schemaVersion: 1,
      sharing: true,
      generatedAt: new Date().toISOString(),
      state: 'ready',
      total: 2,
      notesShared,
      entries: [
        {
          candidateId: BACKUP, kind: 'aboveUsual', day: '2026-11-13T00:00:00Z',
          application: 'com.example.backup', destination: 'example.net',
          bytesOut: 9_500_000_000, usualBytesOut: 400_000_000,
          answer: backupAnswer, answeredAt: backupAnswer ? backupAnsweredAt : null,
          note: notesShared && backupAnswer ? '自分のバックアップ' : null,
        },
        {
          candidateId: CURL, kind: 'newPair', day: '2026-11-12T00:00:00Z',
          application: 'curl', destination: 'example.org', bytesOut: 120_000_000,
        },
      ],
    };
  }

  async function sharing(options) {
    const made = makeApp();
    const { enrolled } = await enrolledAgent(made.app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    await request(made.app, 'PUT', '/api/agent/outbound-candidates', { body: report(options), headers: authorization });
    return { ...made, agentId: enrolled.body.agentId, authorization };
  }

  const answerUrl = (agentId, candidateId) => `/api/agents/outbound-candidates/${agentId}/${candidateId}/answer`;
  const listed = async app => (await request(app, 'GET', '/api/agents/outbound-candidates')).body.agents[0];

  it('Mac Agentの見本の一覧に答えると、Macが読む答えの見本と同じ形で返す', async () => {
    // Both files are read by the Mac's tests too: the list it sends, and the
    // answers it takes back and applies to those same candidates.
    const dir = path.join(__dirname, '../../protocol/agent-outbound-candidates/v1');
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'golden.json'), 'utf8'));
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'answers-golden.json'), 'utf8'));
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const agentId = enrolled.body.agentId;
    assert.equal((await request(app, 'PUT', '/api/agent/outbound-candidates', { body: list, headers: authorization })).status, 200);
    for (const answer of expected.answers) {
      const body = answer.note ? { answer: answer.answer, note: answer.note } : { answer: answer.answer };
      assert.equal((await request(app, 'PUT', answerUrl(agentId, answer.candidateId), { body })).status, 200);
    }
    const response = await request(app, 'GET', '/api/agent/outbound-candidates/answers', { headers: authorization });
    assert.equal(response.status, 200);
    assert.equal(response.body.version, expected.version);
    for (const answer of response.body.answers) {
      assert.match(answer.answeredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
    const shape = answers => answers.map(({ answeredAt: _answeredAt, ...rest }) => rest)
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    assert.deepEqual(shape(response.body.answers), shape(expected.answers));
  });

  it('Hubで答えると一覧はHubの答えを出し、どこで答えたかも示す', async () => {
    const { app, agentId } = await sharing();
    const answered = await request(app, 'PUT', answerUrl(agentId, CURL), { body: { answer: 'investigate', note: '  見覚えがない  ' } });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.version, 1);
    const agent = await listed(app);
    assert.equal(agent.notesShared, true);
    const curl = agent.entries.find(entry => entry.candidateId === CURL);
    assert.equal(curl.answer, 'investigate');
    assert.equal(curl.note, '見覚えがない');
    assert.equal(curl.answeredOn, 'hub');
    assert.equal(agent.entries.find(entry => entry.candidateId === BACKUP).answeredOn, 'agent');
  });

  it('観測を送ったときの応答に答えの版が入り、Agentはその答えを取りに来られる', async () => {
    const { app, agentId, authorization } = await sharing();
    const before = await request(app, 'POST', '/api/agent/ingest', { body: ingestEnvelope(), headers: authorization });
    assert.equal(before.body.outboundAnswersVersion, 0);
    await request(app, 'PUT', answerUrl(agentId, BACKUP), { body: { answer: 'investigate' } });
    const after = await request(app, 'POST', '/api/agent/ingest', { body: ingestEnvelope(), headers: authorization });
    assert.equal(after.body.outboundAnswersVersion, 1);
    const answers = await request(app, 'GET', '/api/agent/outbound-candidates/answers', { headers: authorization });
    assert.equal(answers.status, 200);
    assert.equal(answers.body.version, 1);
    assert.equal(answers.body.answers.length, 1);
    assert.equal(answers.body.answers[0].candidateId, BACKUP);
    assert.equal(answers.body.answers[0].answer, 'investigate');
    assert.equal(answers.body.answers[0].note, null);
    assert.ok(Number.isFinite(Date.parse(answers.body.answers[0].answeredAt)));
  });

  it('Agentの次の送信がHubの答えを消さない。Agentが同じか新しい時刻で答え直したらHubの行は役目を終える', async () => {
    const { app, agentId, authorization } = await sharing();
    const answered = await request(app, 'PUT', answerUrl(agentId, BACKUP), { body: { answer: 'investigate' } });
    // The Agent sends again before it has taken the Hub's answer in.
    await request(app, 'PUT', '/api/agent/outbound-candidates', { body: report(), headers: authorization });
    assert.equal((await listed(app)).entries.find(entry => entry.candidateId === BACKUP).answer, 'investigate');
    // It took the Hub's answer in, keeping the Hub's time.
    const took = new Date(answered.body.answeredAt).toISOString();
    await request(app, 'PUT', '/api/agent/outbound-candidates', {
      body: report({ backupAnswer: 'investigate', backupAnsweredAt: took }), headers: authorization,
    });
    const answers = await request(app, 'GET', '/api/agent/outbound-candidates/answers', { headers: authorization });
    assert.deepEqual(answers.body.answers, []);
    const backup = (await listed(app)).entries.find(entry => entry.candidateId === BACKUP);
    assert.equal(backup.answer, 'investigate');
    assert.equal(backup.answeredOn, 'agent');
  });

  it('Hubで答えを取り消せる', async () => {
    const { app, agentId } = await sharing();
    await request(app, 'PUT', answerUrl(agentId, BACKUP), { body: { answer: null } });
    const backup = (await listed(app)).entries.find(entry => entry.candidateId === BACKUP);
    assert.equal(backup.answer, null);
    assert.equal(backup.note, null);
    assert.equal(backup.answeredOn, 'hub');
  });

  it('メモを共有していないAgentには、Hubでメモを書けない。答えだけなら書ける', async () => {
    const { app, agentId } = await sharing({ notesShared: false });
    const withNote = await request(app, 'PUT', answerUrl(agentId, CURL), { body: { answer: 'expected', note: 'メモ' } });
    assert.equal(withNote.status, 409);
    assert.equal(withNote.body.code, 'notes_not_shared');
    const plain = await request(app, 'PUT', answerUrl(agentId, CURL), { body: { answer: 'expected' } });
    assert.equal(plain.status, 200);
  });

  it('メモを共有するか言わない古いAgentにも、Hubのメモは渡さない', async () => {
    const made = makeApp();
    const { enrolled } = await enrolledAgent(made.app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const body = report();
    delete body.notesShared;
    await request(made.app, 'PUT', '/api/agent/outbound-candidates', { body, headers: authorization });
    assert.equal((await listed(made.app)).notesShared, null);
    const response = await request(made.app, 'PUT', answerUrl(enrolled.body.agentId, CURL), {
      body: { answer: 'expected', note: 'メモ' },
    });
    assert.equal(response.status, 409);
  });

  it('一覧に無い候補、知らないAgent、形の違うidには答えられない', async () => {
    const { app, agentId } = await sharing();
    assert.equal((await request(app, 'PUT', answerUrl(agentId, hashed('other')), { body: { answer: 'expected' } })).status, 404);
    assert.equal((await request(app, 'PUT', answerUrl(crypto.randomUUID(), CURL), { body: { answer: 'expected' } })).status, 404);
    assert.equal((await request(app, 'PUT', answerUrl(agentId, 'newPair|curl'), { body: { answer: 'expected' } })).status, 400);
    assert.equal((await request(app, 'PUT', answerUrl(agentId, CURL), { body: { answer: 'maybe' } })).status, 400);
  });

  it('監査には答えとメモの有無だけを書き、メモの中身は書かない', async () => {
    const { app, agentId, audits } = await sharing();
    await request(app, 'PUT', answerUrl(agentId, CURL), { body: { answer: 'investigate', note: '見覚えがない' } });
    const event = audits.find(item => item.eventType === 'agent_outbound_candidate_answered');
    assert.equal(event.outcome, 'success');
    assert.equal(event.metadata.answer, 'investigate');
    assert.equal(event.metadata.withNote, true);
    assert.equal(JSON.stringify(audits).includes('見覚え'), false);
  });

  it('Agentは自分のHubの答えしか読めない', async () => {
    const { app, agentId } = await sharing();
    await request(app, 'PUT', answerUrl(agentId, CURL), { body: { answer: 'investigate' } });
    const other = await enrolledAgent(app);
    const answers = await request(app, 'GET', '/api/agent/outbound-candidates/answers', {
      headers: { Authorization: `Bearer ${other.enrolled.body.token}` },
    });
    assert.deepEqual(answers.body, { version: 0, answers: [] });
  });

  it('Hubは答えを返せることを伝える', async () => {
    const { app, authorization } = await sharing();
    const response = await request(app, 'GET', '/api/agent/capabilities', { headers: authorization });
    assert.equal(response.body.outboundCandidateAnswers, true);
  });
});

// P3-194: what the Hub knows of each Agent's computer: the addresses its
// flows left from, and what the routers recorded for the LAN one.
describe('Agent details', () => {
  function observation(overrides = {}) {
    const now = Date.now();
    return {
      ...structuredClone(golden.observations[0]),
      firstObservedAt: new Date(now - 1000).toISOString(),
      lastObservedAt: new Date(now).toISOString(),
      ...overrides,
    };
  }

  it('Agentの通信の自分側アドレスを新しい順に返し、ルーターが知っているアドレスにはMACとメーカーを付ける', async () => {
    const known = {
      '192.0.2.10': {
        ip: '192.0.2.10', mac: '00:11:22:aa:bb:cc', vendor: 'Example Inc.', dnsName: 'studio.example',
        mdnsName: null, netbiosName: null, firstSeen: 1, lastSeen: 2,
      },
    };
    const { app } = makeApp({ devices: { getByIp: ip => known[ip] || null } });
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const now = Date.now();
    const envelope = ingestEnvelope();
    envelope.observations = [
      observation({ observationId: '00000000-0000-4000-8000-0000000000d1',
        lastObservedAt: new Date(now - 2000).toISOString(), firstObservedAt: new Date(now - 3000).toISOString() }),
      observation({ observationId: '00000000-0000-4000-8000-0000000000d2', localAddress: '198.51.100.7' }),
      observation({ observationId: '00000000-0000-4000-8000-0000000000d3', localAddress: '127.0.0.1' }),
    ];
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: envelope, headers: authorization })).status, 200);

    const listed = await request(app, 'GET', '/api/agents/details');
    assert.equal(listed.status, 200);
    const [agent] = listed.body.agents;
    assert.equal(agent.agentId, enrolled.body.agentId);
    assert.deepEqual(agent.collectors, ['network-extension']);
    assert.deepEqual(agent.addresses.map(entry => entry.address), ['198.51.100.7', '192.0.2.10']);
    assert.equal(agent.addresses[0].device, null);
    assert.deepEqual(agent.addresses[1].device, {
      mac: '00:11:22:aa:bb:cc', vendor: 'Example Inc.', dnsName: 'studio.example',
      mdnsName: null, netbiosName: null, firstSeen: 1, lastSeen: 2,
    });
  });

  it('まだ何も届いていないAgentはアドレスなしで返し、ルーターの機器一覧がなくても答える', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const listed = await request(app, 'GET', '/api/agents/details');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.agents, [{ agentId: enrolled.body.agentId, collectors: [], addresses: [] }]);
  });
});

// P3-194: how much of the time each Agent's reports reached the Hub.
describe('Agent uptime', () => {
  it('登録中のAgentごとに届いた区切りと途切れを返す。期間は1日か7日だけ', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    assert.equal((await request(app, 'POST', '/api/agent/ingest', { body: ingestEnvelope(), headers: authorization })).status, 200);

    const listed = await request(app, 'GET', '/api/agents/uptime?days=1');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.days, 1);
    const [agent] = listed.body.agents;
    assert.equal(agent.agentId, enrolled.body.agentId);
    assert.equal(agent.deliveredSlots, 1);
    assert.ok(agent.totalSlots >= 1);
    assert.equal((await request(app, 'GET', '/api/agents/uptime')).body.days, 7);
    assert.equal((await request(app, 'GET', '/api/agents/uptime?days=30')).status, 400);
  });

  it('Hubへ送った量と、Hubが古くて除いた件数を同じ期間で返す。再送も送った量に入る', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };
    const first = ingestEnvelope();
    const withOld = ingestEnvelope();
    withOld.batchId = '00000000-0000-4000-8000-0000000000b2';
    withOld.observations[0].observationId = '00000000-0000-4000-8000-0000000000c2';
    const old = structuredClone(withOld.observations[0]);
    old.observationId = '00000000-0000-4000-8000-0000000000c3';
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    old.firstObservedAt = new Date(oldTime - 1000).toISOString();
    old.lastObservedAt = new Date(oldTime).toISOString();
    withOld.observations.push(old);

    const sent = [first, withOld, withOld];
    for (const body of sent) {
      assert.equal((await request(app, 'POST', '/api/agent/ingest', { body, headers: authorization })).status, 200);
    }

    const [agent] = (await request(app, 'GET', '/api/agents/uptime?days=1')).body.agents;
    assert.equal(agent.delivery.requests, 3);
    assert.equal(agent.delivery.requestsWithoutSize, 0);
    assert.equal(agent.delivery.bytes, sent.reduce((sum, body) => sum + Buffer.byteLength(JSON.stringify(body)), 0));
    // The replay of the second batch reports its old observation as a duplicate, not again as left out.
    assert.equal(agent.delivery.expired, 1);
    assert.equal(typeof agent.delivery.countedFrom, 'number');
  });
});
