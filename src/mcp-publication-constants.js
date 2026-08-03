// Shared constants for the remote MCP publication gate.
//
// Split out of mcp-publication-gate.js (P2-68). The gate's evidence
// validation and its live protocol probes both read these, so a single
// definition keeps the two halves from drifting apart.
'use strict';

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

module.exports = {
  EVIDENCE_MAX_AGE_MS,
  MAX_RESPONSE_BYTES,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  CLIENT_PROTOCOL_VERSIONS,
  COGNITO_COPILOT_UNSUPPORTED_STATUS,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  MAX_REPLAY_ACCESS_TOKEN_LIFETIME_SECONDS,
  REFRESH_REPLAY_MODES,
  REQUIRED_EVIDENCE,
  COGNITO_REQUIRED_EVIDENCE,
};
