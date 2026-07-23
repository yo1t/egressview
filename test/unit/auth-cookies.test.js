'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCookies, sessionToken, verifyCookieCsrf, SESSION_COOKIE, CSRF_COOKIE,
} = require('../../src/auth-cookies');

describe('browser authentication cookies', () => {
  it('parses the session cookie without accepting malformed values', () => {
    const req = { headers: { cookie: `${SESSION_COOKIE}=abc123; bad=%E0%A4; x=1` } };
    assert.deepEqual(parseCookies(req.headers.cookie), {
      [SESSION_COOKIE]: 'abc123',
      x: '1',
    });
    assert.equal(sessionToken(req), 'abc123');
  });

  it('requires matching double-submit and stored CSRF tokens only for cookie mutations', () => {
    const sessions = { verifyCsrf: (_session, token) => token === 'safe-token' };
    const req = {
      method: 'POST',
      authSource: 'cookie',
      session: { id: 1 },
      headers: { cookie: `${CSRF_COOKIE}=safe-token` },
      get: name => name === 'X-CSRF-Token' ? 'safe-token' : '',
    };
    assert.equal(verifyCookieCsrf(req, sessions), true);
    req.get = () => 'wrong';
    assert.equal(verifyCookieCsrf(req, sessions), false);
    req.authSource = 'header';
    assert.equal(verifyCookieCsrf(req, sessions), true);
  });
});
