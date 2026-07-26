// Phase 0 of the shared permission model (P2-61).
//
// Browser sessions currently carry no role: requireAdmin grants every
// authenticated session full access. An OIDC domain allowlist therefore makes
// every user in that domain a full administrator, able to change router
// credentials, restore backups and rotate secrets.
//
// Until role-based access control lands, surface that risk wherever the domain
// allowlist is loaded or saved. Existing configurations are never disabled
// automatically — silently locking out remote users would be worse than the
// risk this warns about.
'use strict';

const DOMAIN_ALLOWLIST_WARNING_CODE = 'domain_allowlist_grants_admin';

/**
 * Describe the live risk of the current OIDC configuration.
 * Returns null unless a domain allowlist is actually in effect.
 * @param {{ enabled?: boolean, allowedDomains?: string[] }} [oidcConfig]
 * @returns {{ code: string, domains: string[] }|null}
 */
function domainAllowlistWarning(oidcConfig) {
  const config = oidcConfig || {};
  if (config.enabled !== true) return null;
  const domains = Array.isArray(config.allowedDomains)
    ? config.allowedDomains.filter(value => typeof value === 'string' && value.trim())
    : [];
  if (!domains.length) return null;
  return { code: DOMAIN_ALLOWLIST_WARNING_CODE, domains: [...domains] };
}

/**
 * Collect warnings for an API response. Kept as an array so later phases can
 * add further advisories without changing the response shape.
 */
function securityConfigWarnings(oidcConfig) {
  const warning = domainAllowlistWarning(oidcConfig);
  return warning ? [warning] : [];
}

module.exports = {
  DOMAIN_ALLOWLIST_WARNING_CODE,
  domainAllowlistWarning,
  securityConfigWarnings,
};
