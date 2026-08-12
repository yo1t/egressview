'use strict';

function createDefaultAppState() {
  return {
    adminToken: '',
    homeCountry: 'JP',
    uiLanguage: 'ja',
    autoInvestigate: false,
    retentionDays: 730,
    dnsmasqEnabled: true,
    dnsmasqLogFile: '/var/log/dnsmasq-queries.log',
    inspectEnabled: true,
    inspectLogFile: '/var/log/yamaha-router.log',
    dhcpdEnabled: true,
    dhcpdLogFile: '/var/log/yamaha-router.log',
    httpsEnabled: false,
    httpsCertPath: '',
    httpsKeyPath: '',
    authPasswordHash: '',
    authPasswordSalt: '',
    authPasswordRecord: null,
    agentTokenPepper: '',
    // Opt-in for unencrypted agent traffic over a LAN. Default off: the Hub
    // refuses it until the operator has seen what it exposes (P3-9).
    agentAllowPlaintext: false,
    oidcConfig: {
      enabled: false,
      clientId: '',
      clientSecret: '',
      allowedEmails: [],
      allowedDomains: [],
    },
    beaconConfig: {
      enabled: true,
      minObs: 4,
      maxCov: 0.5,
      minIntervalMs: 60_000,
      maxIntervalMs: 4 * 3600_000,
      scanIntervalMs: 60 * 60 * 1000,
      // Known-benign vendor telemetry — defaults measured against production
      // false positives on 2026-06-12 (296 candidates, all vendor heartbeats)
      whitelistDomains: [
        'amazonaws.com', 'amazon.com', 'amazon.co.jp', 'aws.dev',
        'amazonalexa.com', 'cloudfront.net',
        'firetvcaptiveportal.com', 'mmechocaptiveportal.com',
        'netflix.com', 'nflxvideo.net',
        'daikinsmartdb.jp',
        'time.apple.com', 'push.apple.com',
        'windows.com', 'windowsupdate.com',
      ],
      // RDAP org substrings — candidates resolving to these orgs are excluded
      // unless the destination also hits a threat-intel feed
      orgAllowlist: [
        'Amazon', 'Google', 'Microsoft', 'Apple', 'Akamai',
        'Netflix', 'Fastly', 'Cloudflare', 'GitHub', 'New Relic',
      ],
    },
  };
}

function applyConfigToAppState(appState, data, { isAllowedLogPath, logger }) {
  if (data.general?.homeCountry) appState.homeCountry = data.general.homeCountry;
  if (data.general?.language && ['ja', 'en'].includes(data.general.language)) appState.uiLanguage = data.general.language;
  if (typeof data.general?.autoInvestigate === 'boolean') appState.autoInvestigate = data.general.autoInvestigate;
  if (data.general?.retentionDays) appState.retentionDays = data.general.retentionDays;
  if (data.adminToken) appState.adminToken = data.adminToken;

  if (data.auth && typeof data.auth === 'object') {
    appState.authPasswordHash = data.auth.passwordHash || '';
    appState.authPasswordSalt = data.auth.salt || '';
    appState.authPasswordRecord = data.auth.password &&
      typeof data.auth.password === 'object' ? data.auth.password : null;
    appState.agentAllowPlaintext = data.auth.agentAllowPlaintext === true;
    appState.agentTokenPepper = typeof data.auth.agentTokenPepper === 'string'
      ? data.auth.agentTokenPepper
      : '';
  }
  if (data.oidc && typeof data.oidc === 'object') {
    appState.oidcConfig = {
      enabled: data.oidc.enabled === true,
      clientId: typeof data.oidc.clientId === 'string' ? data.oidc.clientId : '',
      clientSecret: typeof data.oidc.clientSecret === 'string' ? data.oidc.clientSecret : '',
      allowedEmails: Array.isArray(data.oidc.allowedEmails) ? data.oidc.allowedEmails : [],
      allowedDomains: Array.isArray(data.oidc.allowedDomains) ? data.oidc.allowedDomains : [],
    };
  }
  if (data.https && typeof data.https === 'object') {
    appState.httpsEnabled = data.https.enabled === true;
    appState.httpsCertPath = data.https.certPath || '';
    appState.httpsKeyPath = data.https.keyPath || '';
  }
  if (data.beacons && typeof data.beacons === 'object') {
    const bc = appState.beaconConfig;
    if (typeof data.beacons.enabled === 'boolean') bc.enabled = data.beacons.enabled;
    if (Number.isFinite(data.beacons.minObs)) bc.minObs = data.beacons.minObs;
    if (Number.isFinite(data.beacons.maxCov)) bc.maxCov = data.beacons.maxCov;
    if (Number.isFinite(data.beacons.minIntervalMs)) bc.minIntervalMs = data.beacons.minIntervalMs;
    if (Number.isFinite(data.beacons.maxIntervalMs)) bc.maxIntervalMs = data.beacons.maxIntervalMs;
    if (Number.isFinite(data.beacons.scanIntervalMs)) bc.scanIntervalMs = data.beacons.scanIntervalMs;
    if (Array.isArray(data.beacons.whitelistDomains)) bc.whitelistDomains = data.beacons.whitelistDomains;
    if (Array.isArray(data.beacons.orgAllowlist)) bc.orgAllowlist = data.beacons.orgAllowlist;
  }

  const safeLogPath = (label, value, fallback) => {
    if (value === undefined) return fallback;
    if (isAllowedLogPath(value)) return value;
    logger.warn(`[config] ${label} logFile "${value}" is not under an allowed log directory — falling back to ${fallback}. ` +
                'Add the directory via EGRESSVIEW_LOG_PATH_PREFIXES if this path is intentional.');
    return fallback;
  };

  appState.dhcpdEnabled = data.dhcpd?.enabled !== false;
  appState.dhcpdLogFile = safeLogPath('dhcpd', data.dhcpd?.logFile, '/var/log/yamaha-router.log');
  appState.inspectEnabled = data.inspect?.enabled !== false;
  appState.inspectLogFile = safeLogPath('inspect', data.inspect?.logFile, '/var/log/yamaha-router.log');
  appState.dnsmasqEnabled = data.dnsmasq?.enabled !== false;
  appState.dnsmasqLogFile = safeLogPath('dnsmasq', data.dnsmasq?.logFile, '/var/log/dnsmasq-queries.log');

  return appState;
}

module.exports = {
  createDefaultAppState,
  applyConfigToAppState,
};
