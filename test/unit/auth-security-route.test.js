// Unit tests for src/routes/auth-security.js (P2-69)
// Run: node --test test/unit/auth-security-route.test.js
//
// This router carries the OIDC login boundary: the browser state check, the
// server-side role derivation, and the audit rows that record both. It had the
// lowest line coverage of any route module, so the cases below concentrate on
// the paths a failed or forged login takes rather than on the happy path.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const authSecurityRoutes = require('../../src/routes/auth-security');

const requireAdmin = (req, res, next) => next();

function makeCtx(overrides = {}) {
  const audits = [];
  const ctx = {
    appState: { oidcConfig: { enabled: false, clientId: '', clientSecret: '', allowedEmails: [], allowedDomains: [] } },
    saveConfig: () => {},
    sessions: {
      createSession: (label, options) => ({ token: 't', csrfToken: 'c', label, ...options }),
    },
    authAudit: { append: (event) => audits.push(event), list: () => [{ seq: 1 }] },
    oidc: {
      test: async () => ({ issuer: 'https://accounts.google.com' }),
      begin: async () => 'https://accounts.google.com/o/oauth2/v2/auth?state=abc123',
      complete: async () => ({ subject: 'iss|sub', allowlistMatch: 'email' }),
    },
    authCookies: {
      resolveCookieSubpath: () => '',
      cookieOptions: () => ({}),
      parseCookies: (header) => Object.fromEntries(
        String(header || '').split(';').map(p => p.trim().split('=')).filter(p => p[0])
      ),
      setSessionCookies: () => {},
    },
    authenticateRequest: () => null,
    subpath: '',
    ...overrides,
  };
  ctx._audits = audits;
  return ctx;
}

function makeApp(ctx) {
  const app = express();
  app.use(express.json());
  app.use('/api', authSecurityRoutes({ requireAdmin, ...ctx }));
  return app;
}

function req(app, method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = new Readable({
      read() { if (payload) this.push(payload); this.push(null); },
    });
    request.method = method;
    request.url = path;
    request.headers = { ...headers };
    // These routes read req.ip for the audit trail. Express normally derives
    // it from the socket; shadow the getter instead of faking a socket, which
    // breaks body consumption on POST.
    Object.defineProperty(request, 'ip', { value: '198.51.100.7', configurable: true });
    if (payload) {
      request.headers['content-type'] = 'application/json';
      request.headers['content-length'] = String(payload.length);
    }
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
      const head = raw.split('\r\n\r\n')[0];
      const text = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      resolve({ status: response.statusCode, body: parsed, headers: head, raw });
    });
    app.handle(request, response, reject);
  });
}

describe('auth-security: 状態と方式', () => {
  it('未認証では authenticated:false を返す', async () => {
    const { status, body } = await req(makeApp(makeCtx()), 'GET', '/api/auth/status');
    assert.equal(status, 200);
    assert.equal(body.authenticated, false);
    assert.equal(body.authMethod, null);
    assert.equal(body.localLoginEnabled, true);
  });

  it('API token 認証では authMethod=api-token を返す', async () => {
    const ctx = makeCtx({ authenticateRequest: () => 'admin' });
    const { body } = await req(makeApp(ctx), 'GET', '/api/auth/status');
    assert.equal(body.authenticated, true);
    assert.equal(body.authMethod, 'api-token');
  });

  it('session 認証では session の authMethod を返す', async () => {
    const ctx = makeCtx({ authenticateRequest: () => ({ authMethod: 'oidc' }) });
    const { body } = await req(makeApp(ctx), 'GET', '/api/auth/status');
    assert.equal(body.authMethod, 'oidc');
  });

  it('oidc 有効時は methods に反映される', async () => {
    const ctx = makeCtx();
    ctx.appState.oidcConfig.enabled = true;
    const { body } = await req(makeApp(ctx), 'GET', '/api/auth/methods');
    assert.equal(body.google.enabled, true);
    assert.equal(body.local.enabled, true);
  });
});

describe('auth-security: security-config', () => {
  it('client secret を平文で返さず設定済みかだけ示す', async () => {
    const ctx = makeCtx();
    ctx.appState.oidcConfig = {
      enabled: true, clientId: 'cid', clientSecret: 'super-secret',
      allowedEmails: ['ops@example.com'], allowedDomains: [],
    };
    const { body } = await req(makeApp(ctx), 'GET', '/api/auth/security-config');
    assert.equal(body.oidc.clientSecretSet, true);
    assert.equal(JSON.stringify(body).includes('super-secret'), false);
  });

  it('email と domain を小文字へ正規化して保存する', async () => {
    const ctx = makeCtx();
    const { status, body } = await req(makeApp(ctx), 'POST', '/api/auth/security-config', {
      body: {
        enabled: true, clientId: 'cid', clientSecret: 'sec',
        allowedEmails: ['Admin@Example.COM'], allowedDomains: ['CORP.example'],
      },
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(ctx.appState.oidcConfig.allowedEmails, ['admin@example.com']);
    assert.deepEqual(ctx.appState.oidcConfig.allowedDomains, ['corp.example']);
  });

  it('有効化時に allowlist が空なら 400 で拒否する', async () => {
    const ctx = makeCtx();
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/security-config', {
      body: { enabled: true, clientId: 'cid', clientSecret: 'sec', allowedEmails: [], allowedDomains: [] },
    });
    assert.equal(status, 400);
  });

  it('有効化時に credential が欠けていれば 400 で拒否する', async () => {
    const ctx = makeCtx();
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/security-config', {
      body: { enabled: true, clientId: '', clientSecret: '', allowedEmails: ['ops@example.com'], allowedDomains: [] },
    });
    assert.equal(status, 400);
  });

  it('secret 未指定時は保存済みの値を保持する', async () => {
    const ctx = makeCtx();
    ctx.appState.oidcConfig = {
      enabled: true, clientId: 'cid', clientSecret: 'kept', allowedEmails: ['ops@example.com'], allowedDomains: [],
    };
    await req(makeApp(ctx), 'POST', '/api/auth/security-config', {
      body: { enabled: true, clientId: 'cid2', allowedEmails: ['ops@example.com'], allowedDomains: [] },
    });
    assert.equal(ctx.appState.oidcConfig.clientSecret, 'kept');
  });

  it('保存失敗時は 500 を返し設定を元へ戻す', async () => {
    const previous = {
      enabled: false, clientId: 'old', clientSecret: 's', allowedEmails: [], allowedDomains: [],
    };
    const ctx = makeCtx({ saveConfig: () => { throw new Error('disk full'); } });
    ctx.appState.oidcConfig = previous;
    const { status } = await req(makeApp(ctx), 'POST', '/api/auth/security-config', {
      body: { enabled: true, clientId: 'new', clientSecret: 'sec', allowedEmails: ['ops@example.com'], allowedDomains: [] },
    });
    assert.equal(status, 500);
    assert.equal(ctx.appState.oidcConfig, previous, '失敗時に新しい設定が残ってはならない');
  });

  it('設定変更を監査へ記録する', async () => {
    const ctx = makeCtx();
    await req(makeApp(ctx), 'POST', '/api/auth/security-config', {
      body: { enabled: true, clientId: 'cid', clientSecret: 'sec', allowedEmails: [], allowedDomains: ['corp.example'] },
    });
    const event = ctx._audits.find(e => e.eventType === 'security_config_changed');
    assert.ok(event);
    assert.equal(event.metadata.domainAllowlistCount, 1);
  });

  it('未知のキーを拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'POST', '/api/auth/security-config', {
      body: {
        enabled: false, clientId: '', allowedEmails: [], allowedDomains: [], surprise: 1,
      },
    });
    assert.equal(status, 400);
  });
});

describe('auth-security: OIDC コールバック', () => {
  function callbackApp(overrides = {}) {
    const ctx = makeCtx(overrides);
    return { ctx, app: makeApp(ctx) };
  }

  it('state cookie とクエリが一致しなければ 401', async () => {
    const { ctx, app } = callbackApp();
    const { status } = await req(app, 'GET', '/api/auth/oidc/callback?state=query-state', {
      headers: { cookie: 'egressview_oidc_state=different-state' },
    });
    assert.equal(status, 401);
    const failure = ctx._audits.find(e => e.eventType === 'login' && e.outcome === 'failure');
    assert.ok(failure, '失敗も監査されること');
  });

  it('state cookie が無ければ 401', async () => {
    const { app } = callbackApp();
    const { status } = await req(app, 'GET', '/api/auth/oidc/callback?state=query-state');
    assert.equal(status, 401);
  });

  it('email 一致は operator ロールになる', async () => {
    const created = [];
    const { app } = callbackApp({
      oidc: {
        ...makeCtx().oidc,
        complete: async () => ({ subject: 'iss|sub', allowlistMatch: 'email' }),
      },
      sessions: { createSession: (label, options) => { created.push(options); return { token: 't', csrfToken: 'c' }; } },
    });
    const { status } = await req(app, 'GET', '/api/auth/oidc/callback?state=s', {
      headers: { cookie: 'egressview_oidc_state=s' },
    });
    assert.equal(status, 302);
    assert.equal(created[0].role, 'operator');
  });

  it('domain 一致のみは viewer ロールになる', async () => {
    const created = [];
    const { app } = callbackApp({
      oidc: { ...makeCtx().oidc, complete: async () => ({ subject: 'iss|sub', allowlistMatch: 'domain' }) },
      sessions: { createSession: (label, options) => { created.push(options); return { token: 't', csrfToken: 'c' }; } },
    });
    await req(app, 'GET', '/api/auth/oidc/callback?state=s', {
      headers: { cookie: 'egressview_oidc_state=s' },
    });
    // A bulk domain grant is read-only; it must never yield operator or admin.
    assert.equal(created[0].role, 'viewer');
  });

  it('allowlist に一致しなければセッションを作らない', async () => {
    let created = 0;
    const { app } = callbackApp({
      oidc: { ...makeCtx().oidc, complete: async () => ({ subject: 'iss|sub', allowlistMatch: null }) },
      sessions: { createSession: () => { created += 1; return { token: 't', csrfToken: 'c' }; } },
    });
    const { status } = await req(app, 'GET', '/api/auth/oidc/callback?state=s', {
      headers: { cookie: 'egressview_oidc_state=s' },
    });
    assert.equal(status, 401);
    assert.equal(created, 0);
  });

  it('セッション作成に失敗すれば 401', async () => {
    const { app } = callbackApp({ sessions: { createSession: () => null } });
    const { status } = await req(app, 'GET', '/api/auth/oidc/callback?state=s', {
      headers: { cookie: 'egressview_oidc_state=s' },
    });
    assert.equal(status, 401);
  });

  it('失敗理由を監査へ記録するが長さを切り詰める', async () => {
    const { ctx, app } = callbackApp({
      oidc: { ...makeCtx().oidc, complete: async () => { throw new Error('x'.repeat(500)); } },
    });
    await req(app, 'GET', '/api/auth/oidc/callback?state=s', {
      headers: { cookie: 'egressview_oidc_state=s' },
    });
    const failure = ctx._audits.find(e => e.outcome === 'failure');
    assert.ok(failure.metadata.reason.length <= 120);
  });

  it('成功時は login を監査する', async () => {
    const { ctx, app } = callbackApp();
    await req(app, 'GET', '/api/auth/oidc/callback?state=s', {
      headers: { cookie: 'egressview_oidc_state=s' },
    });
    const success = ctx._audits.find(e => e.eventType === 'login' && e.outcome !== 'failure');
    assert.ok(success);
    assert.equal(success.authMethod, 'oidc');
  });
});

describe('auth-security: OIDC 開始とテスト', () => {
  it('開始できない場合は 503 を返し監査する', async () => {
    const ctx = makeCtx({ oidc: { ...makeCtx().oidc, begin: async () => { throw new Error('down'); } } });
    const { status } = await req(makeApp(ctx), 'GET', '/api/auth/oidc/start');
    assert.equal(status, 503);
    assert.ok(ctx._audits.find(e => e.eventType === 'oidc_login_started'));
  });

  it('接続テスト失敗は 502 を返す', async () => {
    const ctx = makeCtx({ oidc: { ...makeCtx().oidc, test: async () => { throw new Error('nope'); } } });
    const { status, body } = await req(makeApp(ctx), 'POST', '/api/auth/oidc/test', { body: {} });
    assert.equal(status, 502);
    assert.ok(body.error);
  });

  it('接続テスト成功は issuer を返す', async () => {
    const { status, body } = await req(makeApp(makeCtx()), 'POST', '/api/auth/oidc/test', { body: {} });
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });
});

describe('auth-security: 監査イベント一覧', () => {
  it('limit と before を検証して渡す', async () => {
    let received = null;
    const ctx = makeCtx({ authAudit: { append: () => {}, list: (args) => { received = args; return []; } } });
    const { status } = await req(makeApp(ctx), 'GET', '/api/auth/audit-events?limit=10&before=1700000000000');
    assert.equal(status, 200);
    assert.deepEqual(received, { limit: 10, before: 1700000000000 });
  });

  it('範囲外の limit を拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'GET', '/api/auth/audit-events?limit=9999');
    assert.equal(status, 400);
  });

  it('未知のクエリを拒否する', async () => {
    const { status } = await req(makeApp(makeCtx()), 'GET', '/api/auth/audit-events?nope=1');
    assert.equal(status, 400);
  });
});
