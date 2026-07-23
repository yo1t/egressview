'use strict';

const net = require('node:net');

function ipv4ToInt(ip) {
  if (net.isIP(ip) !== 4) return null;
  return ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function compileEntry(raw) {
  const entry = String(raw || '').trim();
  if (!entry) return null;
  const [address, prefixRaw] = entry.split('/');
  if (net.isIP(address) === 6) {
    if (prefixRaw != null) throw new Error('IPv6 proxy CIDR is not supported; use an exact address');
    return ip => ip === address || ip === `::ffff:${address}`;
  }
  const value = ipv4ToInt(address);
  if (value == null) throw new Error(`Invalid trusted proxy address: ${entry}`);
  if (prefixRaw == null) {
    return ip => {
      const normalized = String(ip || '').replace(/^::ffff:/, '');
      return ipv4ToInt(normalized) === value;
    };
  }
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid trusted proxy CIDR: ${entry}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ip => {
    const candidate = ipv4ToInt(String(ip || '').replace(/^::ffff:/, ''));
    return candidate != null && (candidate & mask) === (value & mask);
  };
}

function createTrustProxy(value = process.env.EGRESSVIEW_TRUST_PROXY) {
  const matchers = String(value || '').split(',').map(compileEntry).filter(Boolean);
  if (matchers.length === 0) return false;
  return ip => matchers.some(matcher => matcher(ip));
}

module.exports = { createTrustProxy };
