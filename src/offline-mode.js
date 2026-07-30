// Offline mode (P2-65 Phase 2).
//
// A deployment that must not reach the internet at all — an air-gapped or
// tightly egress-filtered network. The guarantee is that no outbound request
// is *attempted*, not that it fails: letting a call go out and time out would
// still emit packets, still leak the fact that EgressView is running, and
// still stall startup for the length of every timeout.
//
// So every outbound-dependent feature is decided here, before the module that
// would perform the call is wired up, and provider SDK clients are never even
// constructed.
//
// What keeps working: router SSH collection, SQLite, the web UI, stdio and
// private HTTP MCP. Those are local by definition.
//
// What is allowed only when explicitly configured: internal DNS/PTR, a
// self-hosted Ollama endpoint, and an internal OIDC issuer. These can be
// reachable inside an isolated network, but they are opt-in rather than
// assumed, because "internal" is a claim about the operator's network that
// EgressView cannot verify.
'use strict';

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
  'internal-oidc',
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
  for (const feature of ALL_GATED_FEATURES) {
    features[feature] = featureStatus(feature, {
      offline,
      configured: Boolean(internalEndpoints[feature]),
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
  featureStatus,
  createOfflinePolicy,
};
