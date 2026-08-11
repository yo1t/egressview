'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const agentRoutes = require('../../src/routes/agents');
const agentIdentities = require('../../src/agent-identities');

const metadata = {
  hostName: 'route-test-mac',
  platform: 'macos',
  osVersion: '26.5.2',
  agentVersion: '0.1.13',
};

beforeEach(() => agentIdentities._initForTest());
after(() => agentIdentities.closeDb());

function makeApp() {
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
    authAudit: { append: event => audits.push(event) },
  }));
  return { app, audits };
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

async function enrolledAgent(app) {
  const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
  const enrolled = await request(app, 'POST', '/api/agent/enroll', {
    body: { code: issued.body.code, agent: metadata },
  });
  return { issued, enrolled };
}

describe('Agent HTTP enrollment', () => {
  it('issues one-time credentials and never lists either plaintext value', async () => {
    const { app, audits } = makeApp();
    const { issued, enrolled } = await enrolledAgent(app);
    assert.equal(issued.status, 201);
    assert.equal(enrolled.status, 201);
    assert.match(issued.body.code, /^egve_/);
    assert.match(enrolled.body.token, /^egva_/);

    const reused = await request(app, 'POST', '/api/agent/enroll', {
      body: { code: issued.body.code, agent: metadata },
    });
    assert.equal(reused.status, 401);

    const listed = await request(app, 'GET', '/api/agents');
    assert.equal(listed.status, 200);
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

  it('rejects unknown fields and prohibited metadata before touching storage', async () => {
    const { app } = makeApp();
    const issued = await request(app, 'POST', '/api/agents/enrollment-tokens');
    const invalid = await request(app, 'POST', '/api/agent/enroll', {
      body: {
        code: issued.body.code,
        agent: { ...metadata, commandLine: 'private-command' },
      },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(agentIdentities.listAgents(), []);
  });

  it('rate-limits repeated invalid enrollment attempts', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 5; i++) {
      const failed = await request(app, 'POST', '/api/agent/enroll', {
        body: { code: `egve_${String(i).padStart(48, '0')}`, agent: metadata },
      });
      assert.equal(failed.status, 401);
    }
    const limited = await request(app, 'POST', '/api/agent/enroll', {
      body: { code: `egve_${'f'.repeat(48)}`, agent: metadata },
    });
    assert.equal(limited.status, 429);
  });

  it('requires HTTPS except on a loopback development listener', async () => {
    const { app } = makeApp();
    const rejected = await request(app, 'POST', '/api/agent/enroll', {
      body: { code: `egve_${'f'.repeat(48)}`, agent: metadata },
      localAddress: '192.168.1.20',
    });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /HTTPS/);
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
    const id = enrolled.body.agent.agentId;
    const revoked = await request(app, 'POST', `/api/agents/${id}/revoke`);
    assert.equal(revoked.status, 200);
    assert.equal(agentIdentities.verifyAgentToken(enrolled.body.token), null);
    assert.equal(agentIdentities.listAgents()[0].agentId, id);
    assert.equal(typeof agentIdentities.listAgents()[0].revokedAt, 'number');
  });
});
