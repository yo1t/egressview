'use strict';

const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const {
  createOAuthResourceServer,
  normalizeCompatibilityProfile,
  normalizeIssuer,
  assertCognitoIssuer,
  OAUTH_COMPATIBILITY_PROFILES,
} = require('./mcp-oauth');

const EVIDENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const CLIENT_PROTOCOL_VERSIONS = new Set([
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
]);
const COGNITO_COPILOT_UNSUPPORTED_STATUS = 'unsupported-random-loopback-port';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const MAX_REPLAY_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const REFRESH_REPLAY_MODES = Object.freeze({
  REJECT_REPLAY: 'reject-replay',
  REVOKE_FAMILY: 'revoke-family',
});
const REQUIRED_EVIDENCE = Object.freeze([
  'directIngress',
  'reverseProxyLimits',
  'rollback',
  'credentialRotation',
  'keycloakBackupRestore',
  'jwksOutage',
  'refreshRevocation',
  'clientCompatibility',
]);
const COGNITO_REQUIRED_EVIDENCE = Object.freeze([
  ...REQUIRED_EVIDENCE.filter((name) => name !== 'keycloakBackupRestore'),
  'cognitoCompatibility',
]);

function envText(env, name, { required = true } = {}) {
  const value = String(env[name] || '').trim();
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(value, fallback, max = 10_000) {
  if (!/^\d+$/.test(String(value || '').trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function safeUrl(value, name, { httpsOnly = true, loopbackOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, query, or fragment`);
  }
  if (httpsOnly && url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (loopbackOnly && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`${name} must use a loopback host`);
  }
  return url;
}

function loadGateConfig(env = process.env) {
  const endpoint = safeUrl(envText(env, 'MCP_GATE_ENDPOINT'), 'MCP_GATE_ENDPOINT');
  if (endpoint.pathname !== '/mcp') throw new Error('MCP_GATE_ENDPOINT must end at /mcp');
  const resource = safeUrl(envText(env, 'MCP_GATE_RESOURCE'), 'MCP_GATE_RESOURCE');
  if (resource.toString() !== endpoint.toString()) {
    throw new Error('MCP_GATE_RESOURCE must exactly match MCP_GATE_ENDPOINT');
  }
  const issuer = safeUrl(envText(env, 'MCP_GATE_ISSUER'), 'MCP_GATE_ISSUER');
  const compatibilityProfile = normalizeCompatibilityProfile(
    env.MCP_GATE_OAUTH_COMPATIBILITY_PROFILE
  );
  if (compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO) {
    assertCognitoIssuer(normalizeIssuer(issuer.toString()));
  }
  const localBase = safeUrl(
    envText(env, 'MCP_GATE_EGRESSVIEW_URL'),
    'MCP_GATE_EGRESSVIEW_URL',
    { httpsOnly: false, loopbackOnly: true }
  );
  const commit = envText(env, 'MCP_GATE_DEPLOYED_COMMIT');
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('MCP_GATE_DEPLOYED_COMMIT must be a full lowercase Git commit');
  }

  return Object.freeze({
    endpoint,
    resource: resource.toString(),
    issuer: issuer.toString().replace(/\/$/, ''),
    compatibilityProfile,
    connectAddress: envText(env, 'MCP_GATE_CONNECT_ADDRESS'),
    readScope: envText(env, 'MCP_GATE_READ_SCOPE'),
    writeScope: envText(env, 'MCP_GATE_WRITE_SCOPE'),
    deployedCommit: commit,
    evidencePath: path.resolve(envText(env, 'MCP_GATE_EVIDENCE_PATH')),
    reportPath: path.resolve(env.MCP_GATE_REPORT_PATH || '.egressview-mcp-publication-gate.json'),
    auditDbPath: path.resolve(envText(env, 'MCP_GATE_AUDIT_DB_PATH')),
    localBase,
    localToken: envText(env, 'MCP_GATE_EGRESSVIEW_TOKEN'),
    tokens: Object.freeze({
      read: envText(env, 'MCP_GATE_READ_TOKEN'),
      write: envText(env, 'MCP_GATE_WRITE_TOKEN'),
      expired: envText(env, 'MCP_GATE_EXPIRED_TOKEN'),
      wrongAudience: envText(env, 'MCP_GATE_WRONG_AUDIENCE_TOKEN'),
      revokedExpired: envText(env, 'MCP_GATE_REVOKED_EXPIRED_TOKEN'),
    }),
    rateProbeRequests: positiveInt(env.MCP_GATE_RATE_PROBE_REQUESTS, 70, 500),
    routerMaxAgeMs: positiveInt(env.MCP_GATE_ROUTER_MAX_AGE_MS, 5 * 60 * 1000, 24 * 60 * 60 * 1000),
    timeoutMs: positiveInt(env.MCP_GATE_TIMEOUT_MS, 10_000, 120_000),
  });
}

function loadEvidence(filePath) {
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read MCP publication evidence: ${error.message}`, { cause: error });
  }
  return evidence;
}

function validateEvidence(evidence, {
  deployedCommit,
  now = Date.now(),
  compatibilityProfile = OAUTH_COMPATIBILITY_PROFILES.STRICT,
  issuer = null,
  resource = null,
}) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['evidence must be a JSON object'];
  }
  if (evidence.schemaVersion !== 3) failures.push('schemaVersion must be 3');
  if (evidence.deployedCommit !== deployedCommit) {
    failures.push('evidence deployedCommit must match MCP_GATE_DEPLOYED_COMMIT');
  }
  if (evidence.publishDns !== false) {
    failures.push('publishDns must remain false during the pre-publication gate');
  }

  const requiredEvidence = compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO
    ? COGNITO_REQUIRED_EVIDENCE
    : REQUIRED_EVIDENCE;
  for (const name of requiredEvidence) {
    const entry = evidence[name];
    if (!entry || entry.passed !== true) {
      failures.push(`${name}.passed must be true`);
      continue;
    }
    const testedAt = Date.parse(entry.testedAt);
    if (!Number.isFinite(testedAt)) {
      failures.push(`${name}.testedAt must be an ISO-8601 timestamp`);
    } else if (testedAt > now + 5 * 60 * 1000 || now - testedAt > EVIDENCE_MAX_AGE_MS) {
      failures.push(`${name}.testedAt must be within the last 30 days`);
    }
  }

  if (evidence.directIngress?.portsClosed !== true) {
    failures.push('directIngress.portsClosed must confirm 443/3000/3002/3010 are not public');
  }
  if (evidence.jwksOutage?.mcpFailedClosed !== true
      || evidence.jwksOutage?.localCollectionContinued !== true) {
    failures.push('jwksOutage must prove MCP fail-closed and local collection continuity');
  }
  const refresh = evidence.refreshRevocation;
  const boundedAccessToken = Number.isInteger(refresh?.accessTokenLifetimeSeconds)
    && refresh.accessTokenLifetimeSeconds > 0
    && refresh.accessTokenLifetimeSeconds <= MAX_REPLAY_ACCESS_TOKEN_LIFETIME_SECONDS;
  if (!boundedAccessToken) {
    failures.push(
      `refreshRevocation.accessTokenLifetimeSeconds must be from 1 to `
      + `${MAX_REPLAY_ACCESS_TOKEN_LIFETIME_SECONDS}`
    );
  }
  if (refresh?.mode === REFRESH_REPLAY_MODES.REJECT_REPLAY) {
    if (refresh.replayRequestRejected !== true || refresh.currentFamilyUsable !== true) {
      failures.push(
        'refreshRevocation reject-replay mode must reject the replay and preserve the current family'
      );
    }
  } else if (refresh?.mode === REFRESH_REPLAY_MODES.REVOKE_FAMILY) {
    if (refresh.familyRevoked !== true || refresh.currentFamilyUsable !== false) {
      failures.push(
        'refreshRevocation revoke-family mode must revoke the complete refresh family'
      );
    }
  } else {
    failures.push('refreshRevocation.mode must be reject-replay or revoke-family');
  }
  const clients = evidence.clientCompatibility;
  if (clients?.claudeCode !== true) {
    failures.push('clientCompatibility must include a successful Claude Code test');
  }
  if (!CLIENT_PROTOCOL_VERSIONS.has(clients?.claudeCodeProtocolVersion)) {
    failures.push('Claude Code must select a supported protocol version');
  }
  if (clients?.copilotCli === true) {
    if (!CLIENT_PROTOCOL_VERSIONS.has(clients.copilotCliProtocolVersion)) {
      failures.push('GitHub Copilot CLI must select a supported protocol version');
    }
  } else if (compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO) {
    if (clients?.copilotCliStatus !== COGNITO_COPILOT_UNSUPPORTED_STATUS) {
      failures.push(
        `Cognito evidence must record Copilot as ${COGNITO_COPILOT_UNSUPPORTED_STATUS}`
      );
    }
  } else {
    failures.push('clientCompatibility must include a successful GitHub Copilot CLI test');
  }
  if (clients?.legacyClient !== true
      || clients?.legacyProtocolVersion !== LEGACY_PROTOCOL_VERSION) {
    failures.push(`clientCompatibility must retain a ${LEGACY_PROTOCOL_VERSION} legacy client`);
  }
  if (compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO) {
    const cognito = evidence.cognitoCompatibility;
    if (cognito?.issuer !== issuer || cognito?.resource !== resource) {
      failures.push('cognitoCompatibility issuer and resource must match the gate configuration');
    }
    if (cognito?.pkceMethod !== 'S256'
        || cognito?.authorizationRequestResource !== true
        || cognito?.tokenRequestResource !== true
        || cognito?.accessTokenAudienceMatched !== true
        || cognito?.refreshAudiencePreserved !== true
        || cognito?.testedClientCallbacksMatched !== true
        || cognito?.oldRefreshRejected !== true
        || cognito?.revokedRefreshRejected !== true) {
      failures.push(
        'cognitoCompatibility must prove PKCE S256, both resource parameters, audience, '
        + 'tested-client callbacks, refresh rotation, replay rejection, and revocation'
      );
    }
    if (clients?.copilotCli === true) {
      if (cognito?.copilotCallbackCompatible !== true) {
        failures.push('Cognito evidence must confirm the successful Copilot callback');
      }
    } else if (cognito?.copilotCallbackCompatible !== false
        || cognito?.copilotCallbackStatus !== COGNITO_COPILOT_UNSUPPORTED_STATUS) {
      failures.push(
        `Cognito evidence must preserve Copilot callback status `
        + COGNITO_COPILOT_UNSUPPORTED_STATUS
      );
    }
    for (const name of ['inspectorVersion', 'claudeCodeVersion', 'copilotCliVersion']) {
      if (typeof cognito?.[name] !== 'string' || !cognito[name].trim()) {
        failures.push(`cognitoCompatibility.${name} must record the tested client version`);
      }
    }
  }
  return failures;
}

function decodeClaims(token, label) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error(`${label} must be a JWT`);
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error(`${label} has malformed JWT claims`);
  }
}

function validateFixtureTokens(config, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  const read = decodeClaims(config.tokens.read, 'MCP_GATE_READ_TOKEN');
  const write = decodeClaims(config.tokens.write, 'MCP_GATE_WRITE_TOKEN');
  const expired = decodeClaims(config.tokens.expired, 'MCP_GATE_EXPIRED_TOKEN');
  const wrongAudience = decodeClaims(
    config.tokens.wrongAudience,
    'MCP_GATE_WRONG_AUDIENCE_TOKEN'
  );
  const revokedExpired = decodeClaims(
    config.tokens.revokedExpired,
    'MCP_GATE_REVOKED_EXPIRED_TOKEN'
  );
  const scopes = (claims) => String(claims.scope || '').split(/\s+/).filter(Boolean);

  if (!scopes(read).includes(config.readScope) || scopes(read).includes(config.writeScope)) {
    throw new Error('MCP_GATE_READ_TOKEN must have read scope without write scope');
  }
  if (!scopes(write).includes(config.readScope) || !scopes(write).includes(config.writeScope)) {
    throw new Error('MCP_GATE_WRITE_TOKEN must have both read and write scopes');
  }
  if (!Number.isFinite(expired.exp) || expired.exp >= nowSeconds) {
    throw new Error('MCP_GATE_EXPIRED_TOKEN must already be expired');
  }
  const wrongAudiences = Array.isArray(wrongAudience.aud)
    ? wrongAudience.aud
    : [wrongAudience.aud];
  if (!Number.isFinite(wrongAudience.exp) || wrongAudience.exp <= nowSeconds
      || wrongAudiences.includes(config.resource)) {
    throw new Error('MCP_GATE_WRONG_AUDIENCE_TOKEN must be unexpired and target another audience');
  }
  if (!Number.isFinite(revokedExpired.exp) || revokedExpired.exp >= nowSeconds) {
    throw new Error(
      'MCP_GATE_REVOKED_EXPIRED_TOKEN must be captured after revocation and retained until expiry'
    );
  }
}

async function verifyFixtureSignatures(config) {
  const verifier = createOAuthResourceServer({
    issuer: config.issuer,
    resource: config.resource,
    requiredScope: config.readScope,
    scopesSupported: [config.readScope, config.writeScope],
    compatibilityProfile: config.compatibilityProfile,
    timeoutMs: config.timeoutMs,
  });
  await verifier.verifyToken(config.tokens.read);
  await verifier.verifyToken(config.tokens.write);

  const rejectionCases = [
    ['MCP_GATE_EXPIRED_TOKEN', config.tokens.expired, /expired/],
    ['MCP_GATE_WRONG_AUDIENCE_TOKEN', config.tokens.wrongAudience, /audience mismatch/],
    ['MCP_GATE_REVOKED_EXPIRED_TOKEN', config.tokens.revokedExpired, /expired/],
  ];
  for (const [name, token, expected] of rejectionCases) {
    try {
      await verifier.verifyToken(token);
      throw new Error(`${name} was unexpectedly accepted`);
    } catch (error) {
      if (!expected.test(error.message)) {
        throw new Error(`${name} did not fail for the expected verified claim`, { cause: error });
      }
    }
  }
}

async function resolveConnectAddress(connectAddress) {
  const records = await dns.promises.lookup(connectAddress, { all: true });
  if (!records.length) throw new Error('MCP_GATE_CONNECT_ADDRESS did not resolve');
  return records;
}

function requestJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 10_000,
  connectRecords,
} = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const lookup = connectRecords
      ? (_hostname, options, callback) => {
          if (options?.all) return callback(null, connectRecords);
          const record = connectRecords.find((item) => item.family === options?.family)
            || connectRecords[0];
          return callback(null, record.address, record.family);
        }
      : undefined;
    const request = transport.request(url, {
      method,
      headers,
      lookup,
      servername: url.hostname,
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function parseJsonResponse(response, label) {
  try {
    return JSON.parse(response.text);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function parseMcpResponse(response, label) {
  const lines = response.text.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const candidate = data.at(-1) || response.text;
  const parsed = parseJsonResponse({ text: candidate }, label);
  if (parsed.error) throw new Error(`${label} returned a JSON-RPC error`);
  return parsed;
}

async function publicDnsRecords(hostname) {
  const results = [];
  for (const resolver of [dns.promises.resolve4, dns.promises.resolve6]) {
    try {
      results.push(...await resolver.call(dns.promises, hostname));
    } catch (error) {
      if (!['ENODATA', 'ENOTFOUND'].includes(error.code)) throw error;
    }
  }
  return results;
}

function bearerHeaders(token, requestId) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Request-Id': requestId,
  };
}

function mcpBody(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function modernMcpBody(id, method, params = {}, version = MODERN_PROTOCOL_VERSION) {
  return mcpBody(id, method, {
    ...params,
    _meta: {
      ...params._meta,
      [PROTOCOL_VERSION_META_KEY]: version,
      [CLIENT_INFO_META_KEY]: { name: 'egressview-publication-gate', version: '1.0.0' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    },
  });
}

function modernBearerHeaders(token, requestId, method, name, version = MODERN_PROTOCOL_VERSION) {
  const headers = {
    ...bearerHeaders(token, requestId),
    'MCP-Protocol-Version': version,
    'Mcp-Method': method,
  };
  if (name) headers['Mcp-Name'] = name;
  return headers;
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expected}`);
  }
}

async function verifyLocalCollection(config, requester = requestJson) {
  const call = (pathname, token = null) => {
    const url = new URL(pathname, config.localBase);
    return requester(url, {
      headers: token ? { 'X-Admin-Token': token } : {},
      timeoutMs: config.timeoutMs,
    });
  };
  const health = await call('/healthz');
  const ready = await call('/readyz');
  expectStatus(health, 200, 'local health');
  expectStatus(ready, 200, 'local readiness');
  const routersResponse = await call('/api/routers', config.localToken);
  expectStatus(routersResponse, 200, 'local router status');
  const routers = parseJsonResponse(routersResponse, 'local router status').routers || [];
  const enabled = routers.filter((router) => router.enabled);
  const now = Date.now();
  if (!enabled.length) throw new Error('no enabled routers were reported');
  for (const router of enabled) {
    const numericLastSuccess = Number(router.lastSuccessAt);
    const lastSuccess = Number.isFinite(numericLastSuccess) && numericLastSuccess > 0
      ? numericLastSuccess
      : Date.parse(router.lastSuccessAt);
    if (!router.ready || !Number.isFinite(lastSuccess)
        || now - lastSuccess > config.routerMaxAgeMs) {
      throw new Error(`router collection is not current for ${router.kind || router.id || 'unknown'}`);
    }
  }
  return { enabledRouters: enabled.length };
}

function verifyAuditRows(dbPath, requestIds) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('MCP audit database integrity_check failed');
    }
    const find = db.prepare(`
      SELECT outcome, reason, subjectHash, clientIdHash
      FROM mcp_audit_events WHERE requestId = ?
      ORDER BY createdAt DESC LIMIT 1
    `);
    const required = {
      malformed: 'invalid_token',
      expired: 'invalid_token',
      wrongAudience: 'invalid_token',
      revokedExpired: 'invalid_token',
      insufficientScope: 'insufficient_scope',
      rateLimited: 'global_rate_limit',
      protocolMismatch: null,
      unsupportedVersion: null,
    };
    for (const [name, reason] of Object.entries(required)) {
      const row = find.get(requestIds[name]);
      if (!row || row.outcome !== 'failure'
          || (reason !== null && row.reason !== reason)) {
        throw new Error(`MCP audit row ${name} is missing or has the wrong outcome`);
      }
    }
    const successful = find.get(requestIds.read);
    if (!successful || successful.outcome !== 'success'
        || !successful.subjectHash || !successful.clientIdHash) {
      throw new Error('successful read audit row lacks pseudonymized identity');
    }
  } finally {
    db.close();
  }
}

async function runPublicationGate(config, dependencies = {}) {
  const requester = dependencies.requester || requestJson;
  const resolveTarget = dependencies.resolveTarget || resolveConnectAddress;
  const resolvePublic = dependencies.resolvePublic || publicDnsRecords;
  const auditVerifier = dependencies.auditVerifier || verifyAuditRows;
  const localVerifier = dependencies.localVerifier || verifyLocalCollection;
  const tokenVerifier = dependencies.tokenVerifier || verifyFixtureSignatures;
  const now = dependencies.now || Date.now;
  const evidence = dependencies.evidence || loadEvidence(config.evidencePath);
  const evidenceFailures = validateEvidence(evidence, {
    deployedCommit: config.deployedCommit,
    now: now(),
    compatibilityProfile: config.compatibilityProfile,
    issuer: config.issuer,
    resource: config.resource,
  });
  if (evidenceFailures.length) {
    throw new Error(`publication evidence failed:\n- ${evidenceFailures.join('\n- ')}`);
  }
  validateFixtureTokens(config, now());
  await tokenVerifier(config);

  const dnsRecords = await resolvePublic(config.endpoint.hostname);
  if (dnsRecords.length) {
    throw new Error('public MCP DNS already resolves; the pre-publication gate requires unpublished DNS');
  }
  const connectRecords = await resolveTarget(config.connectAddress);
  const requestIds = Object.fromEntries([
    'read', 'write', 'malformed', 'expired', 'wrongAudience',
    'revokedExpired', 'insufficientScope', 'rateLimited',
    'legacyInitialize', 'legacyTools', 'modernDiscover', 'modernTools',
    'protocolMismatch', 'unsupportedVersion',
  ].map((name) => [name, `mcp-gate-${name}-${crypto.randomUUID()}`]));

  const call = (pathname, options = {}) => {
    const url = new URL(pathname, config.endpoint);
    return requester(url, {
      timeoutMs: config.timeoutMs,
      connectRecords,
      ...options,
    });
  };

  for (const pathname of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const response = await call(pathname);
    expectStatus(response, 200, `protected resource metadata ${pathname}`);
    const metadata = parseJsonResponse(response, `protected resource metadata ${pathname}`);
    if (metadata.resource !== config.resource
        || !metadata.authorization_servers?.includes(config.issuer)
        || !metadata.scopes_supported?.includes(config.readScope)
        || !metadata.scopes_supported?.includes(config.writeScope)) {
      throw new Error(`protected resource metadata ${pathname} does not match gate configuration`);
    }
  }

  const noToken = await call('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: mcpBody(1, 'initialize'),
  });
  expectStatus(noToken, 401, 'unauthenticated MCP request');
  const challenge = String(noToken.headers['www-authenticate'] || '');
  if (!challenge.includes('resource_metadata=') || !challenge.includes('scope=')) {
    throw new Error('unauthenticated MCP challenge lacks resource metadata or scope');
  }

  const invalidCases = [
    ['malformed', 'not-a-jwt'],
    ['expired', config.tokens.expired],
    ['wrongAudience', config.tokens.wrongAudience],
    ['revokedExpired', config.tokens.revokedExpired],
  ];
  for (const [name, token] of invalidCases) {
    const response = await call('/mcp', {
      method: 'POST',
      headers: bearerHeaders(token, requestIds[name]),
      body: mcpBody(name, 'initialize'),
    });
    expectStatus(response, 401, `${name} token`);
    if (!String(response.headers['www-authenticate'] || '').includes('invalid_token')) {
      throw new Error(`${name} token response lacks invalid_token challenge`);
    }
  }

  const legacyInitializeResponse = await call('/mcp', {
    method: 'POST',
    headers: bearerHeaders(config.tokens.write, requestIds.legacyInitialize),
    body: mcpBody('legacy-initialize', 'initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'egressview-publication-gate', version: '1.0.0' },
    }),
  });
  expectStatus(legacyInitializeResponse, 200, 'legacy initialize');
  const legacyInitialize = parseMcpResponse(legacyInitializeResponse, 'legacy initialize');
  if (legacyInitialize.result?.protocolVersion !== LEGACY_PROTOCOL_VERSION) {
    throw new Error(`legacy initialize did not negotiate ${LEGACY_PROTOCOL_VERSION}`);
  }

  const modernDiscoverResponse = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.write,
      requestIds.modernDiscover,
      'server/discover'
    ),
    body: modernMcpBody('modern-discover', 'server/discover'),
  });
  expectStatus(modernDiscoverResponse, 200, 'modern server discovery');
  const modernDiscover = parseMcpResponse(modernDiscoverResponse, 'modern server discovery');
  if (!modernDiscover.result?.supportedVersions?.includes(MODERN_PROTOCOL_VERSION)) {
    throw new Error(`server/discover did not advertise ${MODERN_PROTOCOL_VERSION}`);
  }

  const legacyToolsResponse = await call('/mcp', {
    method: 'POST',
    headers: bearerHeaders(config.tokens.write, requestIds.legacyTools),
    body: mcpBody('legacy-tools', 'tools/list'),
  });
  expectStatus(legacyToolsResponse, 200, 'legacy tool listing');
  const legacyTools = parseMcpResponse(legacyToolsResponse, 'legacy tool listing');

  const modernToolsResponse = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.write,
      requestIds.modernTools,
      'tools/list'
    ),
    body: modernMcpBody('modern-tools', 'tools/list'),
  });
  expectStatus(modernToolsResponse, 200, 'modern tool listing');
  const modernTools = parseMcpResponse(modernToolsResponse, 'modern tool listing');
  const toolNames = (response) => (response.result?.tools || [])
    .map((tool) => tool.name)
    .sort();
  const legacyToolNames = toolNames(legacyTools);
  const modernToolNames = toolNames(modernTools);
  if (legacyToolNames.length !== 11
      || JSON.stringify(legacyToolNames) !== JSON.stringify(modernToolNames)
      || !modernToolNames.includes('set_device_note')) {
    throw new Error('legacy and modern revisions did not expose the same 11 tools');
  }

  const protocolMismatchResponse = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.read,
      requestIds.protocolMismatch,
      'tools/call'
    ),
    body: modernMcpBody('protocol-mismatch', 'tools/list'),
  });
  expectStatus(protocolMismatchResponse, 400, 'modern header/body mismatch');
  const protocolMismatch = parseJsonResponse(
    protocolMismatchResponse,
    'modern header/body mismatch'
  );
  if (protocolMismatch.error?.code !== -32020) {
    throw new Error('modern header/body mismatch did not return error -32020');
  }

  const unsupportedVersion = '2099-01-01';
  const unsupportedVersionResponse = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.read,
      requestIds.unsupportedVersion,
      'server/discover',
      null,
      unsupportedVersion
    ),
    body: modernMcpBody(
      'unsupported-version',
      'server/discover',
      {},
      unsupportedVersion
    ),
  });
  expectStatus(unsupportedVersionResponse, 400, 'unsupported modern protocol version');
  const unsupported = parseJsonResponse(
    unsupportedVersionResponse,
    'unsupported modern protocol version'
  );
  if (unsupported.error?.code !== -32022) {
    throw new Error('unsupported modern protocol version did not return error -32022');
  }

  const readResponse = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.read,
      requestIds.read,
      'tools/call',
      'get_devices'
    ),
    body: modernMcpBody('read', 'tools/call', {
      name: 'get_devices',
      arguments: {},
    }),
  });
  expectStatus(readResponse, 200, 'read tool');
  parseMcpResponse(readResponse, 'read tool');

  const insufficient = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.read,
      requestIds.insufficientScope,
      'tools/call',
      'set_device_note'
    ),
    body: modernMcpBody('scope', 'tools/call', {
      name: 'set_device_note',
      arguments: { src: '192.0.2.1', note: 'gate probe must not run' },
    }),
  });
  expectStatus(insufficient, 403, 'read token write attempt');
  if (!String(insufficient.headers['www-authenticate'] || '').includes(config.writeScope)) {
    throw new Error('scope challenge does not request the write scope');
  }

  const writeResponse = await call('/mcp', {
    method: 'POST',
    headers: modernBearerHeaders(
      config.tokens.write,
      requestIds.write,
      'tools/list'
    ),
    body: modernMcpBody('write', 'tools/list'),
  });
  expectStatus(writeResponse, 200, 'write-scoped tool listing');
  const toolList = parseMcpResponse(writeResponse, 'write-scoped tool listing');
  if (!toolList.result?.tools?.some((tool) => tool.name === 'set_device_note')) {
    throw new Error('write-scoped token did not expose set_device_note');
  }

  let rateLimited = null;
  for (let index = 0; index < config.rateProbeRequests; index += 1) {
    const requestId = index === config.rateProbeRequests - 1
      ? requestIds.rateLimited
      : `mcp-gate-rate-${crypto.randomUUID()}`;
    const response = await call('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: mcpBody(`rate-${index}`, 'initialize'),
    });
    if (response.status === 429) {
      rateLimited = { ...response, requestId };
      requestIds.rateLimited = requestId;
      break;
    }
  }
  if (!rateLimited || !rateLimited.headers['retry-after']) {
    throw new Error('rate probe did not receive 429 with Retry-After');
  }

  const local = await localVerifier(config, requester);
  auditVerifier(config.auditDbPath, requestIds);

  return Object.freeze({
    schemaVersion: 3,
    status: 'ready_for_manual_dns_review',
    checkedAt: new Date(now()).toISOString(),
    deployedCommit: config.deployedCommit,
    oauthCompatibilityProfile: config.compatibilityProfile,
    endpointHost: config.endpoint.hostname,
    dnsPublished: false,
    enabledRouters: local.enabledRouters,
    checks: Object.freeze({
      evidence: 'pass',
      publicDnsAbsent: 'pass',
      tlsAndMetadata: 'pass',
      tokenRejection: 'pass',
      readWriteScopes: 'pass',
      rateLimit: 'pass',
      audit: 'pass',
      localCollection: 'pass',
      protocolRevisions: Object.freeze({
        [LEGACY_PROTOCOL_VERSION]: 'pass',
        [MODERN_PROTOCOL_VERSION]: 'pass',
      }),
      protocolErrors: 'pass',
      authorizationCompatibility: config.compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO
        ? 'cognito-evidence-pass'
        : 'strict-metadata-pass',
    }),
  });
}

function writeReport(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, filePath);
}

module.exports = {
  EVIDENCE_MAX_AGE_MS,
  LEGACY_PROTOCOL_VERSION,
  MAX_REPLAY_ACCESS_TOKEN_LIFETIME_SECONDS,
  MODERN_PROTOCOL_VERSION,
  REFRESH_REPLAY_MODES,
  REQUIRED_EVIDENCE,
  COGNITO_REQUIRED_EVIDENCE,
  COGNITO_COPILOT_UNSUPPORTED_STATUS,
  loadGateConfig,
  loadEvidence,
  validateEvidence,
  validateFixtureTokens,
  verifyFixtureSignatures,
  requestJson,
  verifyLocalCollection,
  verifyAuditRows,
  runPublicationGate,
  writeReport,
};
