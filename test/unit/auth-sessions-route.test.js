// Unit tests for src/routes/auth-sessions.js (P2-69)
// Run: node --test test/unit/auth-sessions-route.test.js
//
// This router owns the emergency local administrator login and the session
// list, so its rejection paths are the ones an attacker exercises: per-IP
// lockout, the delayed 401 that hides timing, and the rule that the local
// recovery login is always admin because it has to work when an IdP is down.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const authSessionRoutes = require('../../src/routes/auth-sessions');

function makeCtx(overrides = {}) {
  const audits = [];
  const revoked = [];
  const ctx = {
    requireAdmin: (req, res, next) => { req.session = { id: 7 }; next(); },
    getAdminToken: () => 'admin-token',
    saveConfig: () => {},
    appState: {
      authPasswordHash: 'hash',
      authPasswordSalt: 'salt',
      authPasswordRecord: 'record',
    },
    io: { emit: () => {} },
    sessions: {
      createSession: (label, options) => ({ id: 1, token: 'tok', csrfToken: 'csrf', expiresAt: 123, label, ...options }),
      revokeSession: (id) => { revoked.push(id); return id !== 404; },
      revokeAll: (keep) => { revoked.push({ keep }); return 3; },
      listSessions: () => [{ id: 7 }, { id: 8 }],
    },
    authPassword: {
      verifyPassword: (password) => password === 'correct-horse-battery',
      hashPassword: () => ({ salt: 's2', hash: 'h2', record: 'r2' }),
      needsRehash: () => false,
    },
    authAudit: { append: (event) => audits.push(event) },
    authCookies: {
      resolveCookieSubpath: () => '',
      setSessionCookies: () => {},
      clearSessionCookies: () => {},
    },
    subpath: '',
    ...overrides,
  };
  ctx._audits = audits;
  ctx._revoked = revoked;
  return ctx;
}

function makeApp(ctx) {
  const app = express();
  app.use(express.json());
  app.use('/api', authSessionRoutes(ctx));
  return app;
}

function req(app, method, path, { body = null, ip = '198.51.100.7' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = new Readable({
      read() { if (payload) this.push(payload); this.push(null); },
    });
    request.method = method;
    request.url = path;
    request.headers = {};
    if (payload) {
      request.headers['content-type'] = 'application/json';
      request.headers['content-length'] = String(payload.length);
    }
    // Shadow the Express getter rather than faking a socket, which breaks
    // body consumption on POST.
    Object.defineProperty(request, 'ip', { value: ip, configurable: true });
    const response = new http.ServerResponse(request);
    const chunks = [];
    const socket = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    socket.cork = () => {}; socket.uncork = () => {};
    socket.setTimeout = () => {}; socket.destroy = () => {};
    // Express grafts http.IncomingMessage.prototype onto this object, so destroying
    // the stream would run IncomingMessage._destroy against a request that has none
    // of the internal fields that method assumes. Since Node 26.7.0 its abort path
    // detaches a listener from an undefined socket and throws. This is a plain
    // Readable standing in for a request, so give it a plain teardown.
    request._destroy = (error, done) => done(error);
    response.assignSocket(socket);
    response.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      resolve({ status: response.statusCode, body: parsed });
    });
    app.handle(request, response, reject);
  });
}

const GOOD = { password: 'correct-horse-battery' };
const BAD = { password: 'wrong-password-x' };

// A failed login answers through a deliberate 500 ms delay that hides timing.
// The lockout counter is updated before that timer is armed, so drive the
// failures without waiting on the response; otherwise these cases alone would
// add ~9 s to a unit suite that runs in about 3 s.
function failLogin(app, ip) {
  return new Promise((resolve) => {
    req(app, 'POST', '/api/auth/login', { body: BAD, ip }).then(resolve);
    setTimeout(resolve, 20);
  });
}

describe('auth-sessions: ログイン', () => {
  it('パスワード未初期化なら 503', async () => {
    const ctx = makeCtx();
    ctx.appState.authPasswordHash = '';
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(status, 503);
  });

  it('正しいパスワードで session を発行する', async () => {
    const ctx = makeCtx();
    const { status, body } = await req(makeApp(ctx), 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(body.token);
  });

  it('ローカル復旧ログインは常に admin ロールになる', async () => {
    const created = [];
    const ctx = makeCtx({
      sessions: {
        ...makeCtx().sessions,
        createSession: (label, options) => { created.push(options); return { id: 1, token: 't', expiresAt: 1 }; },
      },
    });
    await req(makeApp(ctx), 'POST', '/api/auth/login', { body: GOOD });
    // The recovery path has to work when an IdP is unreachable.
    assert.equal(created[0].role, 'admin');
    assert.equal(created[0].authMethod, 'local');
  });

  it('誤ったパスワードは 401 を返し監査する', async () => {
    const ctx = makeCtx();
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/login', { body: BAD });
    assert.equal(status, 401);
    const failure = ctx._audits.find(e => e.eventType === 'login' && e.outcome === 'failure');
    assert.equal(failure.metadata.reason, 'invalid_credentials');
  });

  it('同一IPの連続失敗で lockout し 429 を返す', async () => {
    const ctx = makeCtx();
    const app = makeApp(ctx);
    for (let i = 0; i < 5; i += 1) await failLogin(app);
    const { status, body } = await req(app, 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(status, 429, '正しいパスワードでも lockout 中は拒否されること');
    assert.ok(body.error);
    const limited = ctx._audits.find(e => e.metadata?.reason === 'rate_limited');
    assert.ok(limited);
  });

  it('lockout は IP 単位で、別IPは影響を受けない', async () => {
    const app = makeApp(makeCtx());
    for (let i = 0; i < 5; i += 1) await failLogin(app, '203.0.113.1');
    const { status } = await req(app, 'POST', '/api/auth/login', { body: GOOD, ip: '203.0.113.2' });
    assert.equal(status, 200);
  });

  it('ログイン成功で失敗カウントがリセットされる', async () => {
    const app = makeApp(makeCtx());
    for (let i = 0; i < 4; i += 1) await failLogin(app);
    await req(app, 'POST', '/api/auth/login', { body: GOOD });
    for (let i = 0; i < 4; i += 1) await failLogin(app);
    const { status } = await req(app, 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(status, 200, 'カウントがリセットされていれば lockout に達しない');
  });

  it('needsRehash なら KDF レコードを更新する', async () => {
    const ctx = makeCtx({
      authPassword: {
        verifyPassword: (p) => p === GOOD.password,
        hashPassword: () => ({ salt: 's2', hash: 'h2', record: 'r2' }),
        needsRehash: () => true,
      },
    });
    await req(makeApp(ctx), 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(ctx.appState.authPasswordRecord, 'r2');
  });

  it('KDF 更新の保存に失敗しても旧レコードへ戻しログインは成功する', async () => {
    const ctx = makeCtx({
      saveConfig: () => { throw new Error('disk full'); },
      authPassword: {
        verifyPassword: (p) => p === GOOD.password,
        hashPassword: () => ({ salt: 's2', hash: 'h2', record: 'r2' }),
        needsRehash: () => true,
      },
    });
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(status, 200, '移行の失敗がログインを妨げてはならない');
    assert.equal(ctx.appState.authPasswordRecord, 'record');
  });

  it('session 生成に失敗すれば 500', async () => {
    const ctx = makeCtx({ sessions: { ...makeCtx().sessions, createSession: () => null } });
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/login', { body: GOOD });
    assert.equal(status, 500);
  });

  it('未知のキーを拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/auth/login', {
      body: { ...GOOD, extra: 1 },
    });
    assert.equal(status, 400);
  });
});

describe('auth-sessions: セッション管理', () => {
  it('ログアウトで自分の session を失効させる', async () => {
    const ctx = makeCtx();
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/logout', { body: {} });
    assert.equal(status, 200);
    assert.equal(ctx._revoked[0], 7);
    assert.ok(ctx._audits.find(e => e.eventType === 'logout'));
  });

  it('一覧では自分の session に current:true が付く', async () => {
    const { body } = await req(makeApp(makeCtx()), 'GET', '/api/auth/sessions');
    assert.equal(body.sessions.find(s => s.id === 7).current, true);
    assert.equal(body.sessions.find(s => s.id === 8).current, false);
  });

  it('存在しない session の失効は 404', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/auth/sessions/404/revoke', { body: {} });
    assert.equal(status, 404);
  });

  it('不正な session id を拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/auth/sessions/abc/revoke', { body: {} });
    assert.equal(status, 400);
  });

  it('revoke-all は既定で自分を残す', async () => {
    const ctx = makeCtx();
    const { body } = await req(makeApp(ctx), 'POST', '/api/auth/sessions/revoke-all', { body: {} });
    assert.equal(body.revoked, 3);
    assert.deepEqual(ctx._revoked[0], { keep: 7 });
  });

  it('includeSelf:true なら自分も失効させる', async () => {
    const ctx = makeCtx();
    await req(makeApp(ctx), 'POST', '/api/auth/sessions/revoke-all', { body: { includeSelf: true } });
    assert.deepEqual(ctx._revoked[0], { keep: null });
  });
});

describe('auth-sessions: パスワード変更', () => {
  const CHANGE = {
    currentPassword: 'correct-horse-battery',
    newPassword: 'a-new-password-that-is-long',
  };

  it('現在のパスワードが違えば 401', async () => {
    const ctx = makeCtx();
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/change-password', {
      body: { ...CHANGE, currentPassword: 'wrong-password-x' },
    });
    assert.equal(status, 401);
    assert.equal(ctx.appState.authPasswordRecord, 'record', '失敗時に書き換わってはならない');
  });

  it('成功すると新しい KDF レコードを保存する', async () => {
    const ctx = makeCtx();
    const { status, body } = await req(makeApp(ctx), 'POST', '/api/auth/change-password', { body: CHANGE });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(ctx.appState.authPasswordRecord, 'r2');
    assert.ok(ctx._audits.find(e => e.eventType === 'password_changed'));
  });

  it('空白のみの新パスワードを拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/auth/change-password', {
      body: { ...CHANGE, newPassword: '                   ' },
    });
    assert.equal(status, 400);
  });

  it('保存に失敗すれば 500 を返し旧パスワードへ戻す', async () => {
    const ctx = makeCtx({ saveConfig: () => { throw new Error('read only'); } });
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/change-password', { body: CHANGE });
    assert.equal(status, 500);
    // Leaving the new hash in memory would lock the operator out after a
    // restart, since the change was never persisted.
    assert.equal(ctx.appState.authPasswordRecord, 'record');
  });

  it('revokeOtherSessions:true で他セッションを失効させる', async () => {
    const ctx = makeCtx({ io: { emit: () => {}, disconnectSockets: () => {} } });
    const { body } = await req(makeApp(ctx), 'POST', '/api/auth/change-password', {
      body: { ...CHANGE, revokeOtherSessions: true },
    });
    assert.equal(body.revoked, 3);
    assert.deepEqual(ctx._revoked[0], { keep: 7 });
  });

  it('短すぎる新パスワードを拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/auth/change-password', {
      body: { ...CHANGE, newPassword: 'short' },
    });
    assert.equal(status, 400);
  });
});

describe('auth-sessions: 管理トークン', () => {
  it('パスワードが違えば再生成を拒否する', async () => {
    const ctx = makeCtx();
    ctx.appState.adminToken = 'original';
    const { status } = await req(makeApp(ctx), 'POST', '/api/admin/regenerate-token', {
      body: { currentPassword: 'wrong-password-x' },
    });
    assert.equal(status, 401);
    assert.equal(ctx.appState.adminToken, 'original');
  });

  it('成功すると新しいトークンを返す', async () => {
    const ctx = makeCtx({ io: { emit: () => {}, disconnectSockets: () => {} } });
    ctx.appState.adminToken = 'original';
    const { status, body } = await req(makeApp(ctx), 'POST', '/api/admin/regenerate-token', {
      body: { currentPassword: 'correct-horse-battery' },
    });
    assert.equal(status, 200);
    assert.notEqual(body.token, 'original');
    assert.equal(ctx.appState.adminToken, body.token);
  });

  it('保存に失敗すれば 500 を返し旧トークンへ戻す', async () => {
    const ctx = makeCtx({ saveConfig: () => { throw new Error('disk full'); } });
    ctx.appState.adminToken = 'original';
    const { status } = await req(makeApp(ctx), 'POST', '/api/admin/regenerate-token', {
      body: { currentPassword: 'correct-horse-battery' },
    });
    assert.equal(status, 500);
    assert.equal(ctx.appState.adminToken, 'original', '保存できなければ既存トークンを失ってはならない');
  });
});

describe('auth-sessions: admin/verify', () => {
  it('一致するトークンを受理する', async () => {
    const { status, body } = await req(makeApp(makeCtx()), 'POST', '/api/admin/verify', {
      body: { token: 'admin-token' },
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it('一致しないトークンを 401 で拒否する', async () => {
    const { status, body } = await req(makeApp(makeCtx()), 'POST', '/api/admin/verify', {
      body: { token: 'wrong-tokenX' },
    });
    assert.equal(status, 401);
    assert.equal(body.ok, false);
  });

  it('長さが異なるトークンでも例外にせず拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/admin/verify', {
      body: { token: 'x' },
    });
    assert.equal(status, 401);
  });

  it('トークン未初期化なら 503', async () => {
    const ctx = makeCtx({ getAdminToken: () => '' });
    const { status } = await req(makeApp(ctx), 'POST', '/api/admin/verify', { body: { token: 'anything' } });
    assert.equal(status, 503);
  });
});
