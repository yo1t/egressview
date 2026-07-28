'use strict';

const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createOAuthResourceServer,
  resourceMetadataUrl,
} = require('../../src/mcp-oauth');

const ISSUER = 'https://idp.example.test/realms/egressview';
const RESOURCE = 'https://monitor.example.test/mcp';
const SCOPE = 'egressview:read';
const NOW_MS = Date.UTC(2026, 6, 26, 14, 0, 0);

let firstKey;
let secondKey;

before(() => {
  firstKey = makeKey('key-1');
  secondKey = makeKey('key-2');
});

function makeKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: 'jwk' }),
      kid,
      use: 'sig',
      alg: 'RS256',
    },
  };
}

function jwt(key, claims = {}, header = {}) {
  const encodedHeader = Buffer.from(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
    kid: key.kid,
    ...header,
  })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: 'pilot-user',
    client_id: 'pilot-client',
    aud: RESOURCE,
    scope: SCOPE,
    iat: NOW_MS / 1000,
    exp: NOW_MS / 1000 + 120,
    ...claims,
  })).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function oauthServer({
  keys = [firstKey.jwk],
  fetchImpl,
  now = () => NOW_MS,
} = {}) {
  const fetcher = fetchImpl || (async (url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return jsonResponse({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        code_challenge_methods_supported: ['S256'],
      });
    }
    return jsonResponse({ keys });
  });
  return createOAuthResourceServer({
    issuer: ISSUER,
    resource: RESOURCE,
    requiredScope: SCOPE,
    scopesSupported: [SCOPE],
    fetchImpl: fetcher,
    now,
  });
}

function mockResponse() {
  const response = {
    statusCode: null,
    body: null,
    headers: {},
  };
  response.set = (name, value) => {
    response.headers[name] = value;
    return response;
  };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

async function runMiddleware(server, authorization) {
  const request = { headers: authorization ? { authorization } : {} };
  const response = mockResponse();
  let nextCalled = false;
  await server.middleware()(request, response, () => {
    nextCalled = true;
  });
  return { request, response, nextCalled };
}

describe('mcp-oauth configuration and metadata', () => {
  it('derives RFC 9728 metadata URLs from the canonical resource path', () => {
    assert.equal(
      resourceMetadataUrl('https://monitor.example.test/mcp'),
      'https://monitor.example.test/.well-known/oauth-protected-resource/mcp'
    );
    assert.equal(
      resourceMetadataUrl('https://monitor.example.test/'),
      'https://monitor.example.test/.well-known/oauth-protected-resource'
    );
  });

  it('rejects non-loopback HTTP issuers and resources', () => {
    assert.throws(
      () => createOAuthResourceServer({
        issuer: 'http://idp.example.test',
        resource: RESOURCE,
        requiredScope: SCOPE,
        scopesSupported: [SCOPE],
      }),
      /must use HTTPS/
    );
  });

  it('rejects scopes that could inject or corrupt challenge headers', () => {
    assert.throws(
      () => createOAuthResourceServer({
        issuer: ISSUER,
        resource: RESOURCE,
        requiredScope: 'read"\r\nX-Injected: yes',
        scopesSupported: ['read"\r\nX-Injected: yes'],
      }),
      /scope-token characters/
    );
  });

  it('publishes only the configured authorization server and scopes', () => {
    const server = oauthServer();
    assert.deepEqual(server.metadata, {
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
    });
  });
});

describe('mcp-oauth JWT verification', () => {
  it('accepts a signed, unexpired, audience-bound token with the required scope', async () => {
    const result = await oauthServer().verifyToken(jwt(firstKey));
    assert.equal(result.claims.sub, 'pilot-user');
    assert.deepEqual(result.scopes, [SCOPE]);
  });

  it('rejects wrong issuer, audience, expiry, and missing identity claims', async () => {
    const server = oauthServer();
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { iss: 'https://other.example.test' })),
      /issuer mismatch/
    );
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { aud: 'https://other.example.test/mcp' })),
      /audience mismatch/
    );
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { aud: [RESOURCE, 'https://other.example.test/mcp'] })),
      /audience mismatch/
    );
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { exp: NOW_MS / 1000 - 31 })),
      /expired/
    );
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { sub: '' })),
      /subject is missing/
    );
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { client_id: undefined, azp: undefined })),
      /client identifier is missing/
    );
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey, { iat: NOW_MS / 1000 + 31 })),
      /issued in the future/
    );
  });

  it('rejects unsigned or unsupported-algorithm tokens before key use', async () => {
    const token = jwt(firstKey, {}, { alg: 'none' });
    await assert.rejects(
      () => oauthServer().verifyToken(token),
      /must use RS256/
    );
  });

  it('rejects JWT payloads that are not JSON objects', async () => {
    const header = Buffer.from(JSON.stringify({
      alg: 'RS256',
      kid: firstKey.kid,
    })).toString('base64url');
    const payload = Buffer.from('null').toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), firstKey.privateKey);
    await assert.rejects(
      () => oauthServer().verifyToken(`${signingInput}.${signature.toString('base64url')}`),
      /Malformed access token/
    );
  });

  it('refreshes JWKS once when a previously unknown kid appears', async () => {
    let jwksRequests = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse({
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      jwksRequests += 1;
      return jsonResponse({ keys: jwksRequests === 1 ? [firstKey.jwk] : [secondKey.jwk] });
    };
    const server = oauthServer({ fetchImpl });
    await server.verifyToken(jwt(firstKey));
    const rotated = await server.verifyToken(jwt(secondKey));
    assert.equal(rotated.claims.sub, 'pilot-user');
    assert.equal(jwksRequests, 2);
  });

  it('coalesces concurrent discovery and JWKS requests', async () => {
    let discoveryRequests = 0;
    let jwksRequests = 0;
    const fetchImpl = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (url.endsWith('/.well-known/openid-configuration')) {
        discoveryRequests += 1;
        return jsonResponse({
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      jwksRequests += 1;
      return jsonResponse({ keys: [firstKey.jwk] });
    };
    const server = oauthServer({ fetchImpl });
    await Promise.all(Array.from({ length: 5 }, () => server.verifyToken(jwt(firstKey))));
    assert.equal(discoveryRequests, 1);
    assert.equal(jwksRequests, 1);
  });

  it('rate-limits forced JWKS refreshes for repeated unknown key IDs', async () => {
    let jwksRequests = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return jsonResponse({
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      jwksRequests += 1;
      return jsonResponse({ keys: [firstKey.jwk] });
    };
    const server = oauthServer({ fetchImpl });
    await server.verifyToken(jwt(firstKey));
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(
        () => server.verifyToken(jwt(secondKey)),
        /Unknown JWT signing key/
      );
    }
    assert.equal(jwksRequests, 2, 'initial load plus one bounded unknown-kid refresh');
  });

  it('fails closed when discovery does not advertise PKCE S256', async () => {
    const server = oauthServer({
      fetchImpl: async () => jsonResponse({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        code_challenge_methods_supported: [],
      }),
    });
    await assert.rejects(
      () => server.verifyToken(jwt(firstKey)),
      /does not advertise PKCE S256/
    );
  });
});

describe('mcp-oauth middleware', () => {
  it('returns a scoped RFC 9728 challenge when no token is present', async () => {
    const { response, nextCalled } = await runMiddleware(oauthServer());
    assert.equal(nextCalled, false);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.error, 'unauthorized');
    assert.match(response.headers['WWW-Authenticate'], /resource_metadata=/);
    assert.match(response.headers['WWW-Authenticate'], /scope="egressview:read"/);
  });

  it('returns 403 and insufficient_scope for a valid token without read scope', async () => {
    const { response, nextCalled } = await runMiddleware(
      oauthServer(),
      `Bearer ${jwt(firstKey, { scope: 'egressview:other' })}`
    );
    assert.equal(nextCalled, false);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.error, 'insufficient_scope');
    assert.match(response.headers['WWW-Authenticate'], /error="insufficient_scope"/);
  });

  it('attaches verified auth context and continues for a valid token', async () => {
    const { request, response, nextCalled } = await runMiddleware(
      oauthServer(),
      `Bearer ${jwt(firstKey)}`
    );
    assert.equal(nextCalled, true);
    assert.equal(response.statusCode, null);
    assert.equal(request.mcpAuth.claims.sub, 'pilot-user');
  });

  it('does not expose provider or token details in validation errors', async () => {
    const { response } = await runMiddleware(oauthServer(), 'Bearer malformed');
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: 'invalid_token' });
    assert.doesNotMatch(JSON.stringify(response.body), /malformed|JWT|Keycloak/i);
  });

  it('fails the public boundary closed when discovery or JWKS is unreachable', async () => {
    const server = oauthServer({
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND auth.internal.example');
      },
    });
    const { response, nextCalled } = await runMiddleware(
      server,
      `Bearer ${jwt(firstKey)}`
    );
    assert.equal(nextCalled, false);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: 'invalid_token' });
    assert.doesNotMatch(JSON.stringify(response.body), /ENOTFOUND|auth\.internal|JWKS/i);
  });
});
