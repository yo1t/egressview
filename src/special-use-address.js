'use strict';

/**
 * Addresses that no organization owns (P3-59).
 *
 * The Hub attaches an `org` to a destination so a reader can see who they
 * talked to. For an address out of one of these ranges there is nobody to
 * name: RDAP answers with the registry's own record for the reservation --
 * `Internet Assigned Numbers Authority` -- and that string identifies none of
 * the destinations it is attached to.
 *
 * That would be merely uninformative if `org` were only a label. It is also
 * the aggregation key, in the browser and in SQL
 * (`history-queries.js`'s `targetExpr`), so every destination sharing the name
 * collapses into one node. Measured on production 2026-09-06: **2,824
 * distinct destinations under a single `Internet Assigned Numbers Authority`
 * entry, 21,120 rows** -- the sixth largest destination group in the
 * database, larger than Google LLC, naming none of them.
 *
 * The test is the address range, never the returned name. A name test would
 * miss another registry answering the same way, and would wrongly strip a
 * destination that IANA legitimately operates.
 */

const net = require('node:net');

/**
 * IPv4 special-purpose ranges (IANA registry), as [dotted base, prefix bits].
 *
 * Kept as data rather than a regex so a reader can check an entry against the
 * IANA registry line by line.
 */
const SPECIAL_USE_IPV4 = [
  ['0.0.0.0', 8],          // this network
  ['10.0.0.0', 8],         // private (RFC 1918)
  ['100.64.0.0', 10],      // shared address space / CGNAT (RFC 6598)
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local, incl. cloud metadata at 169.254.169.254
  ['172.16.0.0', 12],      // private (RFC 1918)
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // TEST-NET-1 (documentation)
  ['192.88.99.0', 24],     // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16],     // private (RFC 1918)
  ['198.18.0.0', 15],      // benchmarking (RFC 2544)
  ['198.51.100.0', 24],    // TEST-NET-2 (documentation)
  ['203.0.113.0', 24],     // TEST-NET-3 (documentation)
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved, incl. 255.255.255.255 broadcast
];

/**
 * IPv6 special-purpose ranges, as [base, prefix bits].
 *
 * IPv4-mapped addresses (`::ffff:0:0/96`) are deliberately absent: they are
 * unwrapped to their embedded IPv4 address and answered by the list above, so
 * `::ffff:10.0.0.1` and `10.0.0.1` cannot disagree.
 */
const SPECIAL_USE_IPV6 = [
  ['::', 128],             // unspecified
  ['::1', 128],            // loopback
  ['64:ff9b::', 96],       // NAT64
  ['100::', 64],           // discard-only
  ['2001::', 32],          // Teredo
  ['2001:db8::', 32],      // documentation
  ['2002::', 16],          // 6to4
  ['fc00::', 7],           // unique local
  ['fe80::', 10],          // link-local
  ['ff00::', 8],           // multicast
];

function ipv4ToInt(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inIpv4Range(value, base, bits) {
  // `>>>` would shift by 32 as a no-op for a /0; no range here uses one, and
  // arithmetic keeps this readable at the cost of nothing measurable.
  const size = 2 ** (32 - bits);
  const start = ipv4ToInt(base);
  return value >= start && value < start + size;
}

/** Expand any IPv6 form to 32 lowercase hex digits, or null if unparseable. */
function ipv6ToHex(address) {
  const lower = address.toLowerCase();
  const [head, tail] = lower.split('::', 2);
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const parts = lower.includes('::')
    ? [...headParts, ...Array(8 - headParts.length - tailParts.length).fill('0'), ...tailParts]
    : headParts;
  if (parts.length !== 8) return null;
  let hex = '';
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    hex += part.padStart(4, '0');
  }
  return hex;
}

function inIpv6Range(hex, base, bits) {
  const baseHex = ipv6ToHex(base);
  if (!baseHex) return false;
  const fullNibbles = Math.floor(bits / 4);
  if (hex.slice(0, fullNibbles) !== baseHex.slice(0, fullNibbles)) return false;
  const remainder = bits % 4;
  if (!remainder) return true;
  const mask = (0xf << (4 - remainder)) & 0xf;
  return (parseInt(hex[fullNibbles], 16) & mask) === (parseInt(baseHex[fullNibbles], 16) & mask);
}

/**
 * Whether this address belongs to a range no organization owns.
 *
 * Anything that is not an IP literal is `false`: a hostname is a name someone
 * chose, and this function has nothing to say about it.
 */
function isSpecialUseAddress(address) {
  const value = String(address == null ? '' : address).trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(value);
  if (family === 4) {
    const asInt = ipv4ToInt(value);
    return asInt !== null && SPECIAL_USE_IPV4.some(([base, bits]) => inIpv4Range(asInt, base, bits));
  }
  if (family !== 6) return false;
  // Unwrap IPv4-mapped and IPv4-compatible forms so both spellings agree.
  const embedded = value.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (embedded && net.isIP(embedded[1]) === 4) return isSpecialUseAddress(embedded[1]);
  const hex = ipv6ToHex(value);
  if (!hex) return false;
  return SPECIAL_USE_IPV6.some(([base, bits]) => inIpv6Range(hex, base, bits));
}

module.exports = { SPECIAL_USE_IPV4, SPECIAL_USE_IPV6, isSpecialUseAddress };
