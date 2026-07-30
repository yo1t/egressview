'use strict';

// Injected at startup; see src/offline-mode.js.
let _offline = null;
function setOfflinePolicy(policy) { _offline = policy; }

const crypto = require('node:crypto');

const ISSUER = 'https://accounts.google.com';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const FLOW_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FLOWS = 1000;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function normalizeList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value).trim().toLowerCase())
    .filter(Boolean))];
}

function createGoogleOidc({
  fetchImpl = global.fetch,
  now = () => Date.now(),
  maxFlows = DEFAULT_MAX_FLOWS,
} = {}) {
  const flows = new Map();
  let discoveryCache = null;
  let discoveryExpiresAt = 0;
  let jwksCache = null;
  let jwksExpiresAt = 0;

  async function fetchJson(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OIDC endpoint returned HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error('OIDC response exceeded the size limit');
    }
    return JSON.parse(text);
  }

  async function discovery() {
    if (_offline?.allows && !_offline.allows('google-oidc')) {
      const error = new Error('Google OIDC is disabled in offline mode');
      error.code = 'offline_mode';
      throw error;
    }
    if (discoveryCache && discoveryExpiresAt > now()) return discoveryCache;
    const document = await fetchJson(DISCOVERY_URL);
    if (document.issuer !== ISSUER ||
        !String(document.authorization_endpoint || '').startsWith('https://accounts.google.com/') ||
        !String(document.token_endpoint || '').startsWith('https://oauth2.googleapis.com/') ||
        !String(document.jwks_uri || '').startsWith('https://www.googleapis.com/')) {
      throw new Error('Google OIDC discovery document failed endpoint validation');
    }
    discoveryCache = document;
    discoveryExpiresAt = now() + 60 * 60_000;
    return document;
  }

  function pruneFlows() {
    const cutoff = now() - FLOW_TTL_MS;
    for (const [state, flow] of flows) {
      if (flow.createdAt < cutoff) flows.delete(state);
    }
  }

  async function begin(config, redirectUri) {
    if (!config?.enabled || !config.clientId || !config.clientSecret) {
      throw new Error('Google OIDC is not fully configured');
    }
    pruneFlows();
    if (flows.size >= maxFlows) {
      throw new Error('Google OIDC has too many pending login attempts');
    }
    const document = await discovery();
    const state = base64url(crypto.randomBytes(32));
    const nonce = base64url(crypto.randomBytes(32));
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    flows.set(state, { nonce, verifier, redirectUri, createdAt: now() });
    const url = new URL(document.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  async function loadJwks(uri) {
    if (jwksCache && jwksExpiresAt > now()) return jwksCache;
    const document = await fetchJson(uri);
    if (!Array.isArray(document.keys)) throw new Error('Google JWKS response is invalid');
    jwksCache = document.keys;
    jwksExpiresAt = now() + 60 * 60_000;
    return jwksCache;
  }

  async function verifyIdToken(token, config, nonce, document) {
    const segments = String(token || '').split('.');
    if (segments.length !== 3) throw new Error('Google ID token is malformed');
    const header = decodeJson(segments[0]);
    const claims = decodeJson(segments[1]);
    if (header.alg !== 'RS256' || !header.kid) throw new Error('Google ID token algorithm is invalid');
    const keys = await loadJwks(document.jwks_uri);
    const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) throw new Error('Google ID token signing key was not found');
    const signatureValid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${segments[0]}.${segments[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(segments[2], 'base64url')
    );
    if (!signatureValid) throw new Error('Google ID token signature is invalid');
    const validIssuers = [ISSUER, 'accounts.google.com'];
    if (!validIssuers.includes(claims.iss)) throw new Error('Google ID token issuer is invalid');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(config.clientId)) throw new Error('Google ID token audience is invalid');
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) {
      throw new Error('Google ID token has expired');
    }
    if (claims.nonce !== nonce) throw new Error('Google ID token nonce is invalid');
    if (claims.email_verified !== true || !claims.email || !claims.sub) {
      throw new Error('Google account email is not verified');
    }
    return claims;
  }

  /**
   * Report how the verified claims matched the allowlist, not merely whether
   * they did. The caller derives the session role from this, so the decision
   * stays server-side and cannot be influenced by a claim the caller supplies.
   * An explicit email entry outranks a domain entry.
   * @returns {'email'|'domain'|null}
   */
  function allowlistMatch(claims, config) {
    const email = String(claims.email || '').toLowerCase();
    const domain = email.split('@')[1] || '';
    if (!email) return null;
    if (normalizeList(config.allowedEmails).includes(email)) return 'email';
    if (domain && normalizeList(config.allowedDomains).includes(domain)) return 'domain';
    return null;
  }

  async function complete(config, { state, code }) {
    pruneFlows();
    const flow = flows.get(String(state || ''));
    if (!flow) throw new Error('OIDC login state is missing or expired');
    flows.delete(state);
    if (!code) throw new Error('OIDC authorization code is missing');
    const document = await discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    const tokens = await fetchJson(document.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const claims = await verifyIdToken(tokens.id_token, config, flow.nonce, document);
    const match = allowlistMatch(claims, config);
    if (!match) throw new Error('Google account is not in the allowlist');
    return {
      subject: `${claims.iss}|${claims.sub}`,
      emailDomain: String(claims.email).split('@')[1]?.toLowerCase() || '',
      // How the allowlist matched, decided here from verified claims. The
      // caller maps this to a role; it is never taken from the token itself.
      allowlistMatch: match,
    };
  }

  async function test(config) {
    if (!config?.clientId || !config?.clientSecret) {
      throw new Error('Client ID and client secret are required');
    }
    const document = await discovery();
    return { issuer: document.issuer };
  }

  return { begin, complete, test, allowlistMatch };
}

module.exports = { createGoogleOidc, setOfflinePolicy, ISSUER };
