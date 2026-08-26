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
  queueConnectionEnrichment = null,
  threatIntel = null,
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
    queueConnectionEnrichment,
    threatIntel,
    isPlaintextAllowed: () => allowPlaintext,
    authAudit: { append: event => audits.push(event) },
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

  it('capabilityを返し、配布済みAgentの送信を変えない', async () => {
    const { app } = makeApp();
    const { enrolled } = await enrolledAgent(app);
    const envelope = ingestEnvelope();
    const authorization = { Authorization: `Bearer ${enrolled.body.token}` };

    const capabilities = await request(app, 'GET', '/api/agent/capabilities', { headers: authorization });
    assert.equal(capabilities.status, 200);
    assert.deepEqual(capabilities.body.schemaVersions, [1]);
    assert.equal(capabilities.body.maxObservationsPerBatch, 200);
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
