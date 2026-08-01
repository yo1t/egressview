'use strict';

const crypto = require('node:crypto');

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const CLOCK_SKEW_SECONDS = 30;
const UNKNOWN_KID_REFRESH_INTERVAL_MS = 10_000;
const OAUTH_COMPATIBILITY_PROFILES = Object.freeze({
  STRICT: 'strict',
  COGNITO: 'cognito',
});

class OAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The client that presented the token. `client_id` is the standard claim;
 * Keycloak issues `azp` instead. Only these two verified claims are trusted —
 * never a header, which the caller controls.
 */
function normalizeClientId(claims) {
  for (const value of [claims.client_id, claims.azp]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, query, or fragment`);
  }
  const localHttp = url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for loopback testing)`);
  }
  return url;
}

function normalizeIssuer(value) {
  const url = safeUrl(value, 'MCP_OAUTH_ISSUER');
  return url.toString().replace(/\/$/, '');
}

function normalizeResource(value) {
  const url = safeUrl(value, 'MCP_OAUTH_RESOURCE');
  return url.toString();
}

function normalizeCompatibilityProfile(value = OAUTH_COMPATIBILITY_PROFILES.STRICT) {
  const profile = String(value || OAUTH_COMPATIBILITY_PROFILES.STRICT).trim().toLowerCase();
  if (!Object.values(OAUTH_COMPATIBILITY_PROFILES).includes(profile)) {
    throw new Error('MCP_OAUTH_COMPATIBILITY_PROFILE must be "strict" or "cognito"');
  }
  return profile;
}

function assertCognitoIssuer(issuer) {
  const url = new URL(issuer);
  const pool = /^\/([a-z0-9-]+)_[A-Za-z0-9]+$/.exec(url.pathname);
  const host = /^cognito-idp\.([a-z0-9-]+)\.(amazonaws\.com(?:\.cn)?)$/.exec(url.hostname);
  if (!pool || !host || pool[1] !== host[1]) {
    throw new Error(
      'Cognito compatibility requires an exact AWS Cognito regional user-pool issuer'
    );
  }
}

function resolveCompatibilityProfile(value, issuer) {
  const profile = normalizeCompatibilityProfile(value);
  if (profile === OAUTH_COMPATIBILITY_PROFILES.COGNITO) assertCognitoIssuer(issuer);
  return profile;
}

function resourceMetadataUrl(resource) {
  const url = new URL(resource);
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  url.pathname = `/.well-known/oauth-protected-resource${suffix}`;
  return url.toString();
}

function decodeJsonSegment(value, label) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new OAuthError('invalid_token', `Malformed JWT ${label}`);
  }
}

function parseJwt(token) {
  if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new OAuthError('invalid_token', 'Malformed access token');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new OAuthError('invalid_token', 'Malformed access token');
  }
  const header = decodeJsonSegment(parts[0], 'header');
  const claims = decodeJsonSegment(parts[1], 'claims');
  if (!header || typeof header !== 'object' || Array.isArray(header)
      || !claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new OAuthError('invalid_token', 'Malformed access token');
  }
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  return match ? match[1] : null;
}

function tokenScopes(claims) {
  if (typeof claims.scope === 'string') {
    return claims.scope.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(claims.scp) && claims.scp.every((scope) => typeof scope === 'string')) {
    return claims.scp;
  }
  return [];
}

async function readJson(response, label) {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function createOAuthResourceServer(options) {
  const issuer = normalizeIssuer(options.issuer);
  const resource = normalizeResource(options.resource);
  const compatibilityProfile = resolveCompatibilityProfile(
    options.compatibilityProfile,
    issuer
  );
  const requiredScope = String(options.requiredScope || '').trim();
  const scopesSupported = [...new Set((options.scopesSupported || []).map(String).filter(Boolean))];
  const scopeToken = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
  if (!requiredScope || !scopesSupported.includes(requiredScope)) {
    throw new Error('MCP OAuth required scope must be included in scopes_supported');
  }
  if (scopesSupported.some((scope) => !scopeToken.test(scope))) {
    throw new Error('MCP OAuth scopes must use RFC 6749 scope-token characters');
  }

  const issuerUrl = new URL(issuer);
  const metadataUrl = `${issuer}/.well-known/openid-configuration`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const cacheTtlMs = options.cacheTtlMs || DEFAULT_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let discoveryCache = null;
  let discoveryPromise = null;
  let jwksCache = null;
  let jwksPromise = null;
  let lastUnknownKidRefreshAt = 0;

  async function fetchJson(url, label) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readJson(response, label);
  }

  async function discovery() {
    if (discoveryCache && discoveryCache.expiresAt > now()) return discoveryCache.value;
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      const document = await fetchJson(metadataUrl, 'Authorization Server Metadata');
      if (document.issuer !== issuer) {
        throw new Error('Authorization Server Metadata issuer mismatch');
      }
      const hasPkceMetadata = Object.hasOwn(document, 'code_challenge_methods_supported');
      const supportsS256 = Array.isArray(document.code_challenge_methods_supported)
        && document.code_challenge_methods_supported.includes('S256');
      const cognitoOmission = compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO
        && !hasPkceMetadata;
      if (!supportsS256 && !cognitoOmission) {
        throw new Error('Authorization Server Metadata does not advertise PKCE S256');
      }
      const jwksUrl = safeUrl(document.jwks_uri, 'Authorization Server jwks_uri');
      if (jwksUrl.origin !== issuerUrl.origin) {
        throw new Error('Authorization Server jwks_uri must use the issuer origin');
      }
      const value = Object.freeze({ ...document, jwks_uri: jwksUrl.toString() });
      discoveryCache = { value, expiresAt: now() + cacheTtlMs };
      return value;
    })();
    try {
      return await discoveryPromise;
    } finally {
      discoveryPromise = null;
    }
  }

  async function loadJwks(force = false) {
    if (!force && jwksCache && jwksCache.expiresAt > now()) return jwksCache.keys;
    if (jwksPromise) return jwksPromise;
    jwksPromise = (async () => {
      const metadata = await discovery();
      const document = await fetchJson(metadata.jwks_uri, 'JWKS');
      if (!Array.isArray(document.keys) || document.keys.length > 100) {
        throw new Error('JWKS must contain at most 100 keys');
      }
      const keys = new Map();
      for (const jwk of document.keys) {
        if (jwk?.kty !== 'RSA' || jwk?.use !== 'sig' || jwk?.alg !== 'RS256' || !jwk?.kid) continue;
        try {
          keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          throw new Error(`JWKS contains an invalid signing key: ${jwk.kid}`);
        }
      }
      if (keys.size === 0) throw new Error('JWKS contains no usable RS256 signing keys');
      jwksCache = { keys, expiresAt: now() + cacheTtlMs };
      return keys;
    })();
    try {
      return await jwksPromise;
    } finally {
      jwksPromise = null;
    }
  }

  async function signingKey(kid) {
    let keys = await loadJwks();
    let key = keys.get(kid);
    if (!key) {
      const currentTime = now();
      if (currentTime - lastUnknownKidRefreshAt >= UNKNOWN_KID_REFRESH_INTERVAL_MS) {
        lastUnknownKidRefreshAt = currentTime;
        keys = await loadJwks(true);
        key = keys.get(kid);
      }
    }
    if (!key) throw new OAuthError('invalid_token', 'Unknown JWT signing key');
    return key;
  }

  async function verifyToken(token) {
    const parsed = parseJwt(token);
    if (parsed.header.alg !== 'RS256' || typeof parsed.header.kid !== 'string') {
      throw new OAuthError('invalid_token', 'Access token must use RS256 with a key ID');
    }
    const key = await signingKey(parsed.header.kid);
    const validSignature = crypto.verify(
      'RSA-SHA256',
      Buffer.from(parsed.signingInput),
      key,
      parsed.signature
    );
    if (!validSignature) throw new OAuthError('invalid_token', 'Invalid access token signature');

    const currentSeconds = Math.floor(now() / 1000);
    const claims = parsed.claims;
    if (claims.iss !== issuer) throw new OAuthError('invalid_token', 'Access token issuer mismatch');
    if (!Number.isFinite(claims.exp) || claims.exp <= currentSeconds - CLOCK_SKEW_SECONDS) {
      throw new OAuthError('invalid_token', 'Access token has expired');
    }
    if (Number.isFinite(claims.nbf) && claims.nbf > currentSeconds + CLOCK_SKEW_SECONDS) {
      throw new OAuthError('invalid_token', 'Access token is not active');
    }
    if (Number.isFinite(claims.iat) && claims.iat > currentSeconds + CLOCK_SKEW_SECONDS) {
      throw new OAuthError('invalid_token', 'Access token was issued in the future');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (audiences.length !== 1 || audiences[0] !== resource) {
      throw new OAuthError('invalid_token', 'Access token audience mismatch');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
      throw new OAuthError('invalid_token', 'Access token subject is missing');
    }
    const clientId = normalizeClientId(claims);
    if (!clientId) {
      throw new OAuthError('invalid_token', 'Access token client identifier is missing');
    }
    const scopes = tokenScopes(claims);
    if (!scopes.includes(requiredScope)) {
      throw new OAuthError('insufficient_scope', 'Required scope is missing', 403);
    }
    return Object.freeze({
      claims: Object.freeze({ ...claims }),
      scopes: Object.freeze(scopes),
      // Normalized identity for per-subject limits and audit pseudonyms.
      // Qualified by issuer so two providers cannot collide on the same sub.
      subject: `${issuer}|${claims.sub}`,
      clientId,
    });
  }

  const metadata = Object.freeze({
    resource,
    authorization_servers: Object.freeze([issuer]),
    bearer_methods_supported: Object.freeze(['header']),
    scopes_supported: Object.freeze(scopesSupported),
  });
  const protectedResourceMetadataUrl = resourceMetadataUrl(resource);

  function challenge(error, scope = requiredScope) {
    const parts = [
      `resource_metadata="${protectedResourceMetadataUrl}"`,
      `scope="${scope}"`,
    ];
    if (error) parts.push(`error="${error}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  function middleware() {
    return async (req, res, next) => {
      const token = bearerToken(req);
      if (!token) {
        res.set('WWW-Authenticate', challenge());
        return res.status(401).json({ error: 'unauthorized' });
      }
      try {
        const auth = await verifyToken(token);
        req.mcpAuth = auth;
        next();
      } catch (error) {
        const oauthError = error instanceof OAuthError
          ? error
          : new OAuthError('invalid_token', 'Access token validation failed');
        res.set('WWW-Authenticate', challenge(oauthError.code));
        return res.status(oauthError.status).json({ error: oauthError.code });
      }
    };
  }

  return Object.freeze({
    issuer,
    resource,
    requiredScope,
    compatibilityProfile,
    metadata,
    protectedResourceMetadataUrl,
    challenge,
    middleware,
    verifyToken,
  });
}

module.exports = {
  OAuthError,
  OAUTH_COMPATIBILITY_PROFILES,
  assertCognitoIssuer,
  createOAuthResourceServer,
  normalizeCompatibilityProfile,
  normalizeIssuer,
  normalizeResource,
  resourceMetadataUrl,
};
