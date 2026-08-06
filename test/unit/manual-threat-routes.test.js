'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { describe, it } = require('node:test');
const express = require('express');
const manualThreatRoutes = require('../../src/routes/manual-threat');
const { createManualThreatLookup } = require('../../src/manual-threat-lookup');

const requireAdmin = (_req, _res, next) => next();

function request(app, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({ read() { if (payload) this.push(payload); this.push(null); } });
    req.method = method;
    req.url = url;
    req.headers = payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {};
    const res = new http.ServerResponse(req);
    const chunks = [];
    const socket = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    socket.cork = () => {};
    socket.uncork = () => {};
    socket.setTimeout = () => {};
    socket.destroy = () => {};
    // Express grafts http.IncomingMessage.prototype onto this object, so destroying
    // the stream would run IncomingMessage._destroy against a request that has none
    // of the internal fields that method assumes. Since Node 26.7.0 its abort path
    // detaches a listener from an undefined socket and throws. This is a plain
    // Readable standing in for a request, so give it a plain teardown.
    req._destroy = (error, done) => done(error);
    res.assignSocket(socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status: res.statusCode, body: JSON.parse(text || 'null') });
    });
    app.handle(req, res, reject);
  });
}

function appFor(manualThreat, saveConfig = () => {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', manualThreatRoutes({ requireAdmin, manualThreat, saveConfig }));
  return app;
}

describe('manual threat routes', () => {
  it('stores keys without returning their values and performs explicit lookup', async () => {
    const manualThreat = createManualThreatLookup({
      http: { get: async () => ({ data: { data: { abuseConfidenceScore: 10 } } }) },
    });
    const app = appFor(manualThreat);
    const saved = await request(app, 'POST', '/api/config/manual-threat', {
      keys: { abuseipdb: 'secret-key' }, cacheTtlMinutes: 30, minIntervalSeconds: 10,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.providers.abuseipdb.keySet, true);
    assert.equal(JSON.stringify(saved.body).includes('secret-key'), false);

    const lookup = await request(app, 'POST', '/api/threat/manual-lookup', {
      ip: '8.8.8.8', providers: ['abuseipdb'],
    });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.results.abuseipdb.ok, true);
  });

  it('rolls runtime configuration back when persistence fails', async () => {
    const manualThreat = createManualThreatLookup();
    manualThreat.configure({ keys: { otx: 'old-key' }, cacheTtlMinutes: 60, minIntervalSeconds: 15 });
    const app = appFor(manualThreat, () => { throw new Error('disk full'); });
    const result = await request(app, 'POST', '/api/config/manual-threat', {
      keys: { otx: 'new-key' }, cacheTtlMinutes: 120,
    });
    assert.equal(result.status, 500);
    assert.equal(manualThreat.exportConfig().keys.otx, 'old-key');
    assert.equal(manualThreat.exportConfig().cacheTtlMinutes, 60);
  });

  it('rejects private IPs and unknown fields before making an external request', async () => {
    let calls = 0;
    const manualThreat = createManualThreatLookup({ http: { get: async () => { calls++; return { data: {} }; } } });
    manualThreat.configure({ keys: { otx: 'key' } });
    const app = appFor(manualThreat);
    const privateResult = await request(app, 'POST', '/api/threat/manual-lookup', {
      ip: '192.168.1.1', providers: ['otx'],
    });
    const unknownResult = await request(app, 'POST', '/api/threat/manual-lookup', {
      ip: '8.8.8.8', providers: ['otx'], surprise: true,
    });
    assert.equal(privateResult.status, 400);
    assert.equal(unknownResult.status, 400);
    assert.equal(calls, 0);
  });
});
