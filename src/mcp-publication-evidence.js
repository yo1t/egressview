// Evidence-file validation for the remote MCP publication gate.
//
// Split out of mcp-publication-gate.js (P2-68). This half never touches the
// network: it decides whether the recorded evidence is complete, fresh and
// internally consistent, so it stays testable without a live endpoint.
'use strict';

const fs = require('node:fs');
const { OAUTH_COMPATIBILITY_PROFILES, createOAuthResourceServer } = require('./mcp-oauth');
const {
  EVIDENCE_MAX_AGE_MS,
  LEGACY_PROTOCOL_VERSION,
  CLIENT_PROTOCOL_VERSIONS,
  COGNITO_COPILOT_UNSUPPORTED_STATUS,
  MAX_REPLAY_ACCESS_TOKEN_LIFETIME_SECONDS,
  REFRESH_REPLAY_MODES,
  REQUIRED_EVIDENCE,
  COGNITO_REQUIRED_EVIDENCE,
} = require('./mcp-publication-constants');

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

module.exports = {
  loadEvidence,
  validateEvidence,
  decodeClaims,
  validateFixtureTokens,
  verifyFixtureSignatures,
};
