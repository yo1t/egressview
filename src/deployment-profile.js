'use strict';

const net = require('node:net');

const PROFILE_IDS = Object.freeze([
  'local-stdio',
  'private-http',
  'private-oauth',
  'public-oauth',
]);

const DEPLOYMENT_PROFILES = Object.freeze({
  'local-stdio': Object.freeze({
    transport: 'stdio',
    authMode: 'scoped-api-identity',
    tls: 'not-required',
    identityProvider: 'none',
    internetExposure: 'prohibited',
    internetRequired: false,
    offlineCapable: true,
  }),
  'private-http': Object.freeze({
    transport: 'http',
    authMode: 'token',
    tls: 'required-off-loopback',
    identityProvider: 'none',
    internetExposure: 'prohibited',
    internetRequired: false,
    offlineCapable: true,
  }),
  'private-oauth': Object.freeze({
    transport: 'http',
    authMode: 'oauth',
    tls: 'required',
    identityProvider: 'internal-oidc',
    internetExposure: 'prohibited',
    internetRequired: false,
    offlineCapable: true,
  }),
  'public-oauth': Object.freeze({
    transport: 'http',
    authMode: 'oauth',
    tls: 'required',
    identityProvider: 'oidc',
    internetExposure: 'allowed-through-publication-gate',
    internetRequired: true,
    offlineCapable: false,
  }),
});

function inferDeploymentProfile({ httpEnabled, authMode }) {
  if (!httpEnabled) return 'local-stdio';
  return authMode === 'oauth' ? 'public-oauth' : 'private-http';
}

function resolveDeploymentProfile(env = process.env, { httpEnabled, authMode = null }) {
  const configured = String(env.EGRESSVIEW_DEPLOYMENT_PROFILE || '').trim().toLowerCase();
  const id = configured || inferDeploymentProfile({ httpEnabled, authMode });
  const profile = DEPLOYMENT_PROFILES[id];
  if (!profile) {
    throw new Error(
      `EGRESSVIEW_DEPLOYMENT_PROFILE must be one of: ${PROFILE_IDS.join(', ')}`
    );
  }

  if (profile.transport === 'stdio' && httpEnabled) {
    throw new Error(`${id} requires stdio transport; remove MCP_PORT`);
  }
  if (profile.transport === 'http' && !httpEnabled) {
    throw new Error(`${id} requires HTTP transport; set MCP_PORT`);
  }
  if (profile.authMode === 'token' && authMode !== 'token') {
    throw new Error(`${id} requires MCP_AUTH_MODE=token`);
  }
  if (profile.authMode === 'oauth' && authMode !== 'oauth') {
    throw new Error(`${id} requires MCP_AUTH_MODE=oauth`);
  }

  return Object.freeze({
    id,
    configured: configured !== '',
    ...profile,
  });
}

function isLoopbackAddress(address) {
  if (net.isIPv4(address)) return address.split('.')[0] === '127';
  if (net.isIPv6(address)) {
    return address === '::1' || address === '0:0:0:0:0:0:0:1';
  }
  return false;
}

function resolveMcpBindConfig(env = process.env, profile) {
  if (!profile || profile.transport !== 'http') {
    throw new Error('MCP bind configuration requires an HTTP deployment profile');
  }

  const address = String(env.MCP_BIND_ADDRESS || '127.0.0.1').trim();
  if (!net.isIP(address)) {
    throw new Error('MCP_BIND_ADDRESS must be an IPv4 or IPv6 address');
  }

  const loopback = isLoopbackAddress(address);
  if (!loopback) {
    if (!profile.configured) {
      throw new Error(
        'Non-loopback MCP_BIND_ADDRESS requires an explicit EGRESSVIEW_DEPLOYMENT_PROFILE'
      );
    }
    if (String(env.MCP_ALLOW_NON_LOOPBACK || '').trim().toLowerCase() !== 'true') {
      throw new Error(
        'Non-loopback MCP_BIND_ADDRESS requires MCP_ALLOW_NON_LOOPBACK=true'
      );
    }
  }

  return Object.freeze({
    address,
    loopback,
    explicitlyApproved: !loopback,
  });
}

module.exports = {
  DEPLOYMENT_PROFILES,
  PROFILE_IDS,
  inferDeploymentProfile,
  isLoopbackAddress,
  resolveMcpBindConfig,
  resolveDeploymentProfile,
};
