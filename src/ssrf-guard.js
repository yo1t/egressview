'use strict';

// SSRF guard for operator-configured outbound endpoints.
//
// EgressView lets an administrator point a few features (today: the self-hosted
// Ollama endpoint) at a host they control. A self-hosted Ollama legitimately
// lives on loopback or an RFC1918 LAN address, so those must keep working.
//
// The danger on a cloud instance is a different class of address: the
// link-local metadata endpoint (IPv4 169.254.169.254, IPv6 fd00:ec2::254) can
// hand IAM credentials to whatever fetches it. Unspecified, broadcast, and
// multicast addresses are never a valid Ollama target either. This module
// rejects exactly those ranges, in every mode, without touching the loopback
// and private ranges Ollama depends on.
//
// Scope: this classifies IP *literals*. A hostname that resolves to a blocked
// address (DNS rebinding) is not caught here; that needs connect-time
// enforcement and is tracked as a separate follow-up.

const net = require('node:net');

function isBlockedOutboundIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0) return true;                 // 0.0.0.0/8 "this host" / unspecified
  if (a === 169 && b === 254) return true;  // 169.254.0.0/16 link-local (incl. IMDS 169.254.169.254)
  if (a >= 224) return true;                // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

// Extract the embedded IPv4 of an IPv4-mapped IPv6 address (::ffff:x). The URL
// parser rewrites `::ffff:169.254.169.254` to the hextet form `::ffff:a9fe:a9fe`,
// so both spellings must resolve back to the same IPv4 before classification.
function mappedIpv4(normalized) {
  const match = normalized.match(/^::ffff:(.+)$/);
  if (!match) return null;
  const rest = match[1];
  if (rest.includes('.')) return net.isIPv4(rest) ? rest : null;
  const hextets = rest.split(':');
  if (hextets.length !== 2) return null;
  const high = Number.parseInt(hextets[0], 16);
  const low = Number.parseInt(hextets[1], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  if (high < 0 || high > 0xffff || low < 0 || low > 0xffff) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

function isBlockedOutboundIpv6(address) {
  const normalized = address.split('%')[0]; // drop any zone identifier
  if (normalized === '::') return true;      // unspecified

  const embedded = mappedIpv4(normalized);
  if (embedded) return isBlockedOutboundIpv4(embedded);

  const first = Number.parseInt(normalized.split(':')[0] || '0', 16) || 0;
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (normalized === 'fd00:ec2::254') return true; // EC2 IMDS over IPv6
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True when the given address is an IP literal that must never be the target of
 * an operator-configured outbound request. Returns false for hostnames (not an
 * IP literal) and for the loopback/private ranges Ollama legitimately uses.
 */
function isBlockedOutboundIpLiteral(address) {
  const normalized = String(address || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedOutboundIpv4(normalized);
  if (family === 6) return isBlockedOutboundIpv6(normalized);
  return false;
}

module.exports = { isBlockedOutboundIpLiteral };
