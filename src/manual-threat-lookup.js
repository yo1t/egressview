'use strict';

// Injected at startup; see src/offline-mode.js.
let _offline = null;
function setOfflinePolicy(policy) { _offline = policy; }

const net = require('node:net');
const axios = require('axios');

const PROVIDERS = Object.freeze(['abuseipdb', 'virustotal', 'otx']);
const DEFAULT_CACHE_TTL_MINUTES = 60;
const DEFAULT_MIN_INTERVAL_SECONDS = 15;

function isPublicIpAddress(ip) {
  const family = net.isIP(String(ip || ''));
  if (!family) return false;
  if (family === 4) {
    const octets = ip.split('.').map(Number);
    return !(octets[0] === 0
      || octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 192 && octets[1] === 0 && (octets[2] === 0 || octets[2] === 2))
      || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || (octets[1] === 51 && octets[2] === 100)))
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
      || octets[0] >= 224);
  }
  const normalized = ip.toLowerCase();
  return normalized !== '::' && normalized !== '::1'
    && !normalized.startsWith('::ffff:')
    && !/^f[cd]/.test(normalized)
    && !/^fe[89ab]/.test(normalized)
    && !normalized.startsWith('ff')
    && !normalized.startsWith('2001:db8:');
}

function summarizeAbuseIpDb(body) {
  const data = body?.data || {};
  return {
    abuseConfidenceScore: Number(data.abuseConfidenceScore) || 0,
    totalReports: Number(data.totalReports) || 0,
    lastReportedAt: data.lastReportedAt || null,
    countryCode: data.countryCode || null,
    isp: data.isp || null,
    domain: data.domain || null,
    usageType: data.usageType || null,
  };
}

function summarizeVirusTotal(body) {
  const attrs = body?.data?.attributes || {};
  const stats = attrs.last_analysis_stats || {};
  return {
    malicious: Number(stats.malicious) || 0,
    suspicious: Number(stats.suspicious) || 0,
    harmless: Number(stats.harmless) || 0,
    undetected: Number(stats.undetected) || 0,
    reputation: Number(attrs.reputation) || 0,
    country: attrs.country || null,
    network: attrs.network || null,
    owner: attrs.as_owner || null,
    lastAnalysisAt: attrs.last_analysis_date ? attrs.last_analysis_date * 1000 : null,
  };
}

function summarizeOtx(body) {
  const pulses = body?.pulse_info?.pulses || [];
  return {
    pulseCount: Number(body?.pulse_info?.count) || pulses.length,
    reputation: Number(body?.reputation) || 0,
    countryCode: body?.country_code || null,
    asn: body?.asn || null,
    pulses: pulses.slice(0, 5).map(pulse => ({
      id: String(pulse.id || ''),
      name: String(pulse.name || '').slice(0, 200),
      created: pulse.created || null,
      tlp: pulse.TLP || null,
    })),
  };
}

function createManualThreatLookup({ http = axios, now = Date.now } = {}) {
  let keys = { abuseipdb: '', virustotal: '', otx: '' };
  let cacheTtlMinutes = DEFAULT_CACHE_TTL_MINUTES;
  let minIntervalSeconds = DEFAULT_MIN_INTERVAL_SECONDS;
  const cache = new Map();
  const lastRequests = new Map();

  function configure(input = {}) {
    if (input.keys) {
      for (const provider of PROVIDERS) {
        if (typeof input.keys[provider] === 'string') keys[provider] = input.keys[provider].trim();
      }
    }
    if (Number.isInteger(input.cacheTtlMinutes)) cacheTtlMinutes = input.cacheTtlMinutes;
    if (Number.isInteger(input.minIntervalSeconds)) minIntervalSeconds = input.minIntervalSeconds;
    cache.clear();
    lastRequests.clear();
  }

  function exportConfig() {
    return { keys: { ...keys }, cacheTtlMinutes, minIntervalSeconds };
  }

  function getPublicConfig() {
    return {
      providers: Object.fromEntries(PROVIDERS.map(provider => [provider, { keySet: !!keys[provider] }])),
      cacheTtlMinutes,
      minIntervalSeconds,
    };
  }

  async function requestProvider(provider, ip) {
    if (provider === 'abuseipdb') {
      const response = await http.get('https://api.abuseipdb.com/api/v2/check', {
        params: { ipAddress: ip, maxAgeInDays: 90 },
        headers: { Accept: 'application/json', Key: keys[provider] },
        timeout: 10_000,
        maxContentLength: 2 * 1024 * 1024,
      });
      return summarizeAbuseIpDb(response.data);
    }
    if (provider === 'virustotal') {
      const response = await http.get(`https://www.virustotal.com/api/v3/ip_addresses/${encodeURIComponent(ip)}`, {
        headers: { Accept: 'application/json', 'x-apikey': keys[provider] },
        timeout: 10_000,
        maxContentLength: 2 * 1024 * 1024,
      });
      return summarizeVirusTotal(response.data);
    }
    const indicatorType = net.isIP(ip) === 6 ? 'IPv6' : 'IPv4';
    const response = await http.get(`https://otx.alienvault.com/api/v1/indicators/${indicatorType}/${encodeURIComponent(ip)}/general`, {
      headers: { Accept: 'application/json', 'X-OTX-API-KEY': keys[provider] },
      timeout: 10_000,
      maxContentLength: 2 * 1024 * 1024,
    });
    return summarizeOtx(response.data);
  }

  async function lookup(ip, requestedProviders = PROVIDERS) {
    if (_offline?.allows && !_offline.allows('manual-threat-lookup')) {
      const error = new Error('Manual threat lookup is disabled in offline mode');
      error.code = 'offline_mode';
      throw error;
    }
    if (!isPublicIpAddress(ip)) throw new Error('a public IP address is required');
    const providers = [...new Set(requestedProviders)];
    if (!providers.length || providers.some(provider => !PROVIDERS.includes(provider))) {
      throw new Error('at least one supported provider is required');
    }
    const checkedAt = now();
    const results = {};
    await Promise.all(providers.map(async provider => {
      if (!keys[provider]) {
        results[provider] = { ok: false, error: 'API key is not configured' };
        return;
      }
      const cacheKey = `${provider}:${ip}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > checkedAt) {
        results[provider] = { ...cached.value, cached: true };
        return;
      }
      const nextAllowedAt = (lastRequests.get(provider) || 0) + minIntervalSeconds * 1000;
      if (checkedAt < nextAllowedAt) {
        results[provider] = { ok: false, error: 'Rate limit cooldown is active', retryAfterMs: nextAllowedAt - checkedAt };
        return;
      }
      lastRequests.set(provider, checkedAt);
      try {
        const summary = await requestProvider(provider, ip);
        const value = { ok: true, summary, checkedAt };
        cache.set(cacheKey, { value, expiresAt: checkedAt + cacheTtlMinutes * 60_000 });
        results[provider] = { ...value, cached: false };
      } catch (error) {
        const status = Number(error?.response?.status) || null;
        results[provider] = {
          ok: false,
          error: status === 401 || status === 403 ? 'API key was rejected'
            : status === 429 ? 'Provider rate limit exceeded'
            : 'Provider request failed',
          status,
        };
      }
    }));
    return { ip, checkedAt, results };
  }

  return { configure, exportConfig, getPublicConfig, lookup };
}

const manualThreatLookup = createManualThreatLookup();

module.exports = {
  setOfflinePolicy,
  PROVIDERS,
  createManualThreatLookup,
  isPublicIpAddress,
  manualThreatLookup,
  summarizeAbuseIpDb,
  summarizeOtx,
  summarizeVirusTotal,
};
