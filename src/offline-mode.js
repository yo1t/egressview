// Offline mode (P2-65 Phase 2).
//
// A deployment that must not reach the internet at all — an air-gapped or
// tightly egress-filtered network. The guarantee is that no outbound request
// is *attempted*, not that it fails: letting a call go out and time out would
// still emit packets, still leak the fact that EgressView is running, and
// still stall startup for the length of every timeout.
//
// So every outbound-dependent feature is decided here before startup work can
// perform a call, and provider SDK clients are never even constructed.
//
// What keeps working: router SSH collection, SQLite, the web UI, stdio and
// private HTTP MCP. Those are local by definition.
//
// What is allowed only when explicitly configured: internal DNS/PTR and a
// self-hosted Ollama endpoint. They must use private or loopback IP literals so
// offline mode does not depend on untrusted DNS classification.
'use strict';

const net = require('node:net');

const OFFLINE_ENV = 'EGRESSVIEW_OFFLINE_MODE';

// Features that always require the public internet. Disabled unconditionally.
const INTERNET_FEATURES = Object.freeze([
  'rdap',
  'geoip',
  'threat-intel',
  'oui-update',
  'manual-threat-lookup',
  'google-oidc',
  'ai-anthropic',
  'ai-openai',
  'ai-bedrock',
]);

// Features that may be satisfied by a host inside an isolated network, and are
// therefore permitted only when the operator has pointed them somewhere.
const INTERNAL_CAPABLE_FEATURES = Object.freeze([
  'dns-ptr',
  'ai-ollama',
]);

const ALL_GATED_FEATURES = Object.freeze([...INTERNET_FEATURES, ...INTERNAL_CAPABLE_FEATURES]);

function truthy(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Read offline mode from the environment. Only the exact string "true" enables
 * it: a typo must not silently leave a deployment believing it is isolated.
 */
function isOfflineMode(env = process.env) {
  return truthy(env[OFFLINE_ENV]);
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || a === 0
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::') return true;
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function isPrivateIpLiteral(address) {
  const normalized = String(address || '').trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(normalized);
  return family === 4 ? isPrivateIpv4(normalized) : family === 6 && isPrivateIpv6(normalized);
}

function parseInternalEndpoint(feature, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (feature === 'dns-ptr') {
    if (!isPrivateIpLiteral(raw)) {
      throw new Error('EGRESSVIEW_INTERNAL_DNS must be a loopback or private IP address in offline mode');
    }
    return raw;
  }
  if (feature === 'ai-ollama') {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('Ollama endpoint must be a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Ollama endpoint must use HTTP(S) without credentials, query, or fragment');
    }
    if (!isPrivateIpLiteral(parsed.hostname)) {
      throw new Error('Ollama endpoint must use a loopback or private IP address in offline mode');
    }
    return raw;
  }
  throw new Error(`Unknown internal endpoint feature: ${feature}`);
}

/**
 * Decide one feature. Returns a reason code rather than a bare boolean so the
 * API and UI can say *why* something is unavailable instead of showing an
 * unexplained empty panel.
 *
 * @returns {{ enabled: boolean, reason: string|null }}
 */
function featureStatus(feature, { offline, configured = false } = {}) {
  if (!ALL_GATED_FEATURES.includes(feature)) {
    throw new Error(`Unknown offline-gated feature: ${feature}`);
  }
  if (!offline) return { enabled: true, reason: null };
  if (INTERNET_FEATURES.includes(feature)) {
    return { enabled: false, reason: 'offline_mode' };
  }
  // Internal-capable: allowed only when pointed at something.
  return configured
    ? { enabled: true, reason: null }
    : { enabled: false, reason: 'offline_mode_requires_internal_endpoint' };
}

/**
 * Build the runtime capability set once, at startup, so no caller has to
 * re-derive it and no code path can accidentally skip the check.
 *
 * @param {{ env?: object, internalEndpoints?: object }} options
 *   `internalEndpoints` marks which internal-capable features the operator has
 *   actually configured, e.g. `{ 'ai-ollama': true }`.
 */
function createOfflinePolicy({ env = process.env, internalEndpoints = {} } = {}) {
  const offline = isOfflineMode(env);
  const features = {};
  const endpoints = {};
  for (const feature of ALL_GATED_FEATURES) {
    let configured = Boolean(internalEndpoints[feature]);
    if (offline && INTERNAL_CAPABLE_FEATURES.includes(feature) && configured) {
      endpoints[feature] = parseInternalEndpoint(feature, internalEndpoints[feature]);
      configured = true;
    }
    features[feature] = featureStatus(feature, {
      offline,
      configured,
    });
  }
  return Object.freeze({
    offline,
    features: Object.freeze(features),
    /** True when the feature may run. */
    allows(feature) {
      const status = features[feature];
      if (!status) throw new Error(`Unknown offline-gated feature: ${feature}`);
      return status.enabled;
    },
    /** Reason code when disabled, else null. */
    reasonFor(feature) {
      const status = features[feature];
      if (!status) throw new Error(`Unknown offline-gated feature: ${feature}`);
      return status.reason;
    },
    endpointFor(feature) {
      if (!INTERNAL_CAPABLE_FEATURES.includes(feature)) {
        throw new Error(`Feature does not accept an internal endpoint: ${feature}`);
      }
      return endpoints[feature] || null;
    },
    allowsEndpoint(feature, value) {
      if (!offline) return true;
      if (!features[feature]?.enabled) return false;
      try {
        parseInternalEndpoint(feature, value);
        return true;
      } catch {
        return false;
      }
    },
    /** Shape returned to the UI and API so both explain a disabled feature identically. */
    describe() {
      return {
        offlineMode: offline,
        features: Object.fromEntries(
          Object.entries(features).map(([name, status]) => [name, { ...status }])
        ),
      };
    },
  });
}

module.exports = {
  OFFLINE_ENV,
  INTERNET_FEATURES,
  INTERNAL_CAPABLE_FEATURES,
  ALL_GATED_FEATURES,
  isOfflineMode,
  isPrivateIpLiteral,
  parseInternalEndpoint,
  featureStatus,
  createOfflinePolicy,
};
