'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createDemoReadOnly } = require('../../src/demo-read-only');

// Minimal req/res doubles mirroring how the middleware runs under
// app.use('/api', ...): originalUrl keeps the /api prefix.
function run({ method, originalUrl }) {
  const mw = createDemoReadOnly();
  const req = { method, originalUrl, url: originalUrl.replace(/^\/api/, '') };
  let statusCode = 200;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  mw(req, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

describe('demo read-only middleware', () => {
  it('lets read methods through', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const r = run({ method, originalUrl: '/api/devices' });
      assert.equal(r.nextCalled, true, method);
    }
  });

  it('blocks state-changing methods with 403 demo_read_only', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = run({ method, originalUrl: '/api/backup/restore' });
      assert.equal(r.nextCalled, false, method);
      assert.equal(r.statusCode, 403, method);
      assert.equal(r.body.error, 'demo_read_only', method);
    }
  });

  it('allows the login and verify endpoints so visitors can authenticate', () => {
    for (const originalUrl of ['/api/auth/login', '/api/admin/verify', '/api/auth/login?next=/']) {
      const r = run({ method: 'POST', originalUrl });
      assert.equal(r.nextCalled, true, originalUrl);
    }
  });

  it('does not treat a similar path as the allowed login path', () => {
    const r = run({ method: 'POST', originalUrl: '/api/auth/login-attempts' });
    assert.equal(r.statusCode, 403);
  });
});
