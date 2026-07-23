'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGoogleOidc, ISSUER } = require('../../src/oidc-google');

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

describe('Google OIDC adapter', () => {
  it('uses PKCE/state/nonce and verifies the signed identity plus allowlist', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: 'jwk' });
    publicJwk.kid = 'test-key';
    publicJwk.alg = 'RS256';
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    };
    let authorization;
    const fetchImpl = async (url, options = {}) => {
      if (String(url).includes('.well-known')) return response(discovery);
      if (String(url).includes('/certs')) return response({ keys: [publicJwk] });
      if (String(url).includes('/token')) {
        const flow = authorization;
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
        const claims = Buffer.from(JSON.stringify({
          iss: ISSUER,
          aud: 'client-id',
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: flow.searchParams.get('nonce'),
          sub: 'subject-1',
          email: 'admin@example.com',
          email_verified: true,
        })).toString('base64url');
        const input = `${header}.${claims}`;
        const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
        assert.equal(new URLSearchParams(options.body).has('code_verifier'), true);
        return response({ id_token: `${input}.${signature}` });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const oidc = createGoogleOidc({ fetchImpl });
    const config = {
      enabled: true,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      allowedEmails: [],
      allowedDomains: ['example.com'],
    };
    authorization = new URL(await oidc.begin(config, 'https://app.example/api/auth/oidc/callback'));
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    const identity = await oidc.complete(config, {
      state: authorization.searchParams.get('state'),
      code: 'authorization-code',
    });
    assert.match(identity.subject, /subject-1/);
    assert.equal(identity.emailDomain, 'example.com');
  });

  it('rejects missing flow state before contacting the token endpoint', async () => {
    const oidc = createGoogleOidc({ fetchImpl: async () => { throw new Error('not called'); } });
    await assert.rejects(
      oidc.complete({ clientId: 'x' }, { state: 'missing', code: 'x' }),
      /state is missing or expired/
    );
  });

  it('fails closed when too many browser login flows are pending', async () => {
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    };
    const oidc = createGoogleOidc({
      fetchImpl: async () => response(discovery),
      maxFlows: 1,
    });
    const config = {
      enabled: true,
      clientId: 'client-id',
      clientSecret: 'client-secret',
    };
    await oidc.begin(config, 'https://app.example/api/auth/oidc/callback');
    await assert.rejects(
      oidc.begin(config, 'https://app.example/api/auth/oidc/callback'),
      /too many pending login attempts/
    );
  });
});
