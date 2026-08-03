// Rejection-path tests for src/oidc-google.js (P2-69)
// Run: node --test test/unit/oidc-google-rejections.test.js
//
// The happy path was already covered. Every case here is a way a forged or
// replayed login can be presented, and each one is a branch that had no test:
// a mis-signed token, a swapped key id, a wrong audience or issuer, a replayed
// nonce, an unverified email, an expired assertion, or a discovery document
// pointing somewhere other than Google.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGoogleOidc, ISSUER } = require('../../src/oidc-google');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwk(key, kid = 'test-key') {
  const exported = key.export({ format: 'jwk' });
  exported.kid = kid;
  exported.alg = 'RS256';
  return exported;
}

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};

const CONFIG = {
  enabled: true,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  allowedEmails: ['admin@example.com'],
  allowedDomains: ['corp.example'],
};

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function signToken({ claims, signer = privateKey, kid = 'test-key', alg = 'RS256', mangle = false }) {
  const header = Buffer.from(JSON.stringify({ alg, kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(mangle ? `${input}x` : input), signer);
  return `${input}.${signature.toString('base64url')}`;
}

// Drive a full begin/complete round trip with a token the test controls.
async function attempt({ claims: claimOverrides = {}, tokenOptions = {}, keys, discovery = DISCOVERY }) {
  let authorization;
  const oidc = createGoogleOidc({
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('.well-known')) return response(discovery);
      if (target.includes('/certs')) return response({ keys: keys || [jwk(publicKey)] });
      if (target.includes('/token')) {
        const claims = {
          iss: ISSUER,
          aud: CONFIG.clientId,
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: authorization.searchParams.get('nonce'),
          sub: 'subject-1',
          email: 'admin@example.com',
          email_verified: true,
          ...claimOverrides,
        };
        return response({ id_token: signToken({ claims, ...tokenOptions }) });
      }
      throw new Error(`Unexpected URL: ${target}`);
    },
  });
  const url = await oidc.begin(CONFIG, 'https://app.example/callback');
  authorization = new URL(url);
  return oidc.complete(CONFIG, {
    state: authorization.searchParams.get('state'),
    code: 'auth-code',
  });
}

describe('Google OIDC: 署名とクレームの拒否経路', () => {
  it('署名が一致しないトークンを拒否する', async () => {
    await assert.rejects(attempt({ tokenOptions: { mangle: true } }), /signature is invalid/);
  });

  it('別の鍵で署名されたトークンを拒否する', async () => {
    await assert.rejects(
      attempt({ tokenOptions: { signer: otherPair.privateKey } }),
      /signature is invalid/
    );
  });

  it('JWKSに存在しないkidを拒否する', async () => {
    await assert.rejects(attempt({ tokenOptions: { kid: 'unknown-kid' } }), /signing key was not found/);
  });

  it('RS256以外のalgを拒否する', async () => {
    // Guards against an alg-confusion downgrade.
    await assert.rejects(attempt({ tokenOptions: { alg: 'HS256' } }), /algorithm is invalid/);
  });

  it('issuerが異なるトークンを拒否する', async () => {
    await assert.rejects(attempt({ claims: { iss: 'https://evil.example' } }), /issuer is invalid/);
  });

  it('audienceが自分のclient_idでないトークンを拒否する', async () => {
    await assert.rejects(attempt({ claims: { aud: 'someone-else' } }), /audience is invalid/);
  });

  it('期限切れトークンを拒否する', async () => {
    await assert.rejects(
      attempt({ claims: { exp: Math.floor(Date.now() / 1000) - 1 } }),
      /has expired/
    );
  });

  it('expが数値でないトークンを拒否する', async () => {
    await assert.rejects(attempt({ claims: { exp: 'soon' } }), /has expired/);
  });

  it('nonceが一致しないトークンを拒否する', async () => {
    // The replay guard: a token minted for a different login attempt.
    await assert.rejects(attempt({ claims: { nonce: 'other-nonce' } }), /nonce is invalid/);
  });

  it('email_verifiedがtrueでないトークンを拒否する', async () => {
    await assert.rejects(attempt({ claims: { email_verified: false } }), /email/i);
  });

  it('subが無いトークンを拒否する', async () => {
    await assert.rejects(attempt({ claims: { sub: undefined } }), /email|sub/i);
  });

  it('形式が壊れたトークンを拒否する', async () => {
    const oidc = createGoogleOidc({
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes('.well-known')) return response(DISCOVERY);
        if (target.includes('/certs')) return response({ keys: [jwk(publicKey)] });
        return response({ id_token: 'not.a-valid-token' });
      },
    });
    const url = new URL(await oidc.begin(CONFIG, 'https://app.example/callback'));
    await assert.rejects(
      oidc.complete(CONFIG, { state: url.searchParams.get('state'), code: 'c' }),
      /malformed|invalid/i
    );
  });
});

describe('Google OIDC: discovery と JWKS の検証', () => {
  it('Google以外を指すdiscovery documentを拒否する', async () => {
    await assert.rejects(
      attempt({ discovery: { ...DISCOVERY, token_endpoint: 'https://evil.example/token' } }),
      /endpoint validation/
    );
  });

  it('issuerが異なるdiscovery documentを拒否する', async () => {
    await assert.rejects(
      attempt({ discovery: { ...DISCOVERY, issuer: 'https://evil.example' } }),
      /endpoint validation/
    );
  });

  it('JWKSがkeys配列でない場合に拒否する', async () => {
    const oidc = createGoogleOidc({
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes('.well-known')) return response(DISCOVERY);
        if (target.includes('/certs')) return response({ keys: 'not-an-array' });
        // A well-formed token, so the failure lands on the JWKS check rather
        // than on header decoding, which happens first.
        return response({
          id_token: signToken({
            claims: {
              iss: ISSUER, aud: CONFIG.clientId,
              exp: Math.floor(Date.now() / 1000) + 300,
              sub: 's', email: 'admin@example.com', email_verified: true,
            },
          }),
        });
      },
    });
    const url = new URL(await oidc.begin(CONFIG, 'https://app.example/cb'));
    await assert.rejects(
      oidc.complete(CONFIG, { state: url.searchParams.get('state'), code: 'c' }),
      /JWKS response is invalid/
    );
  });
});

describe('Google OIDC: flow 状態管理', () => {
  it('未知のstateを拒否する', async () => {
    const oidc = createGoogleOidc({ fetchImpl: async () => response(DISCOVERY) });
    await assert.rejects(
      oidc.complete(CONFIG, { state: 'never-issued', code: 'c' }),
      /state is missing or expired/
    );
  });

  it('stateは一度しか使えない', async () => {
    let authorization;
    const oidc = createGoogleOidc({
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.includes('.well-known')) return response(DISCOVERY);
        if (target.includes('/certs')) return response({ keys: [jwk(publicKey)] });
        return response({
          id_token: signToken({
            claims: {
              iss: ISSUER, aud: CONFIG.clientId,
              exp: Math.floor(Date.now() / 1000) + 300,
              nonce: authorization.searchParams.get('nonce'),
              sub: 's', email: 'admin@example.com', email_verified: true,
            },
          }),
        });
      },
    });
    authorization = new URL(await oidc.begin(CONFIG, 'https://app.example/callback'));
    const state = authorization.searchParams.get('state');
    await oidc.complete(CONFIG, { state, code: 'c' });
    // Replaying the same authorization must not mint a second session.
    await assert.rejects(oidc.complete(CONFIG, { state, code: 'c' }), /state is missing or expired/);
  });

  it('codeが無い場合に拒否する', async () => {
    const oidc = createGoogleOidc({ fetchImpl: async () => response(DISCOVERY) });
    const url = new URL(await oidc.begin(CONFIG, 'https://app.example/callback'));
    await assert.rejects(
      oidc.complete(CONFIG, { state: url.searchParams.get('state'), code: '' }),
      /code is missing/
    );
  });

  it('期限切れのflowはpruneされる', async () => {
    // FLOW_TTL_MS is 10 minutes; advance the injected clock past it.
    let clock = 1_000_000;
    const oidc = createGoogleOidc({
      fetchImpl: async () => response(DISCOVERY),
      now: () => clock,
    });
    const url = new URL(await oidc.begin(CONFIG, 'https://app.example/callback'));
    clock += 11 * 60_000;
    await assert.rejects(
      oidc.complete(CONFIG, { state: url.searchParams.get('state'), code: 'c' }),
      /state is missing or expired/
    );
  });

  it('未設定のconfigではbeginを拒否する', async () => {
    const oidc = createGoogleOidc({ fetchImpl: async () => response(DISCOVERY) });
    for (const config of [
      { enabled: false, clientId: 'a', clientSecret: 'b' },
      { enabled: true, clientId: '', clientSecret: 'b' },
      { enabled: true, clientId: 'a', clientSecret: '' },
      undefined,
    ]) {
      await assert.rejects(oidc.begin(config, 'https://app.example/cb'), /not fully configured/);
    }
  });

  it('保留中のflowが多すぎる場合はbeginを拒否する', async () => {
    const oidc = createGoogleOidc({
      fetchImpl: async () => response(DISCOVERY),
      maxFlows: 2,
    });
    await oidc.begin(CONFIG, 'https://app.example/cb');
    await oidc.begin(CONFIG, 'https://app.example/cb');
    await assert.rejects(oidc.begin(CONFIG, 'https://app.example/cb'), /too many pending/);
  });
});

describe('Google OIDC: allowlist 判定', () => {
  const oidc = createGoogleOidc({ fetchImpl: async () => response(DISCOVERY) });

  it('明示的なemail一致はdomain一致より優先される', () => {
    // The caller derives the session role from this, and email outranks domain.
    assert.equal(
      oidc.allowlistMatch(
        { email: 'admin@corp.example' },
        { allowedEmails: ['admin@corp.example'], allowedDomains: ['corp.example'] }
      ),
      'email'
    );
  });

  it('domainのみ一致はdomainを返す', () => {
    assert.equal(
      oidc.allowlistMatch({ email: 'someone@corp.example' }, CONFIG),
      'domain'
    );
  });

  it('大文字小文字を無視して一致させる', () => {
    assert.equal(oidc.allowlistMatch({ email: 'ADMIN@EXAMPLE.COM' }, CONFIG), 'email');
  });

  it('一致しない場合はnullを返す', () => {
    assert.equal(oidc.allowlistMatch({ email: 'nobody@other.example' }, CONFIG), null);
  });

  it('emailが無い場合はnullを返す', () => {
    assert.equal(oidc.allowlistMatch({}, CONFIG), null);
    assert.equal(oidc.allowlistMatch({ email: '' }, CONFIG), null);
  });

  it('allowlistに載らないアカウントはcompleteで拒否される', async () => {
    await assert.rejects(
      attempt({ claims: { email: 'intruder@other.example' } }),
      /not in the allowlist/
    );
  });
});

describe('Google OIDC: test()', () => {
  it('client_id/secretが無ければ拒否する', async () => {
    const oidc = createGoogleOidc({ fetchImpl: async () => response(DISCOVERY) });
    await assert.rejects(oidc.test({ clientId: '', clientSecret: 'x' }), /required/);
    await assert.rejects(oidc.test({ clientId: 'x', clientSecret: '' }), /required/);
    await assert.rejects(oidc.test(undefined), /required/);
  });

  it('成功時はissuerを返す', async () => {
    const oidc = createGoogleOidc({ fetchImpl: async () => response(DISCOVERY) });
    assert.deepEqual(await oidc.test(CONFIG), { issuer: ISSUER });
  });
});
