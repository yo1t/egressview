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
 * IPv4 special-purpose ranges (IANA registry), as [dotted base, prefix bits],
 * and for some a third element: what the log's country column calls a
 * destination there (P3-174). A LAN device has no country, and a blank cell
 * put the home router beside the addresses nobody could place. The words are
 * the same in every language; the other reserved ranges stay blank.
 *
 * Kept as data rather than a regex so a reader can check an entry against the
 * IANA registry line by line.
 */
const SPECIAL_USE_IPV4 = [
  ['0.0.0.0', 8],                   // this network
  ['10.0.0.0', 8, 'LAN'],           // private (RFC 1918)
  ['100.64.0.0', 10, 'CGNAT'],      // shared address space / CGNAT (RFC 6598)
  ['127.0.0.0', 8, 'loopback'],     // loopback
  ['169.254.0.0', 16, 'LAN'],       // link-local, incl. cloud metadata at 169.254.169.254
  ['172.16.0.0', 12, 'LAN'],        // private (RFC 1918)
  ['192.0.0.0', 24],                // IETF protocol assignments
  ['192.0.2.0', 24],                // TEST-NET-1 (documentation)
  ['192.88.99.0', 24],              // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16, 'LAN'],       // private (RFC 1918)
  ['198.18.0.0', 15],               // benchmarking (RFC 2544)
  ['198.51.100.0', 24],             // TEST-NET-2 (documentation)
  ['203.0.113.0', 24],              // TEST-NET-3 (documentation)
  ['224.0.0.0', 4],                 // multicast
  ['240.0.0.0', 4],                 // reserved, incl. 255.255.255.255 broadcast
];

/**
 * IPv6 special-purpose ranges, as [base, prefix bits].
 *
 * IPv4-mapped addresses (`::ffff:0:0/96`) are deliberately absent: they are
 * unwrapped to their embedded IPv4 address and answered by the list above, so
 * `::ffff:10.0.0.1` and `10.0.0.1` cannot disagree.
 */
const SPECIAL_USE_IPV6 = [
  ['::', 128],                      // unspecified
  ['::1', 128, 'loopback'],         // loopback
  ['64:ff9b::', 96],                // NAT64
  ['100::', 64],                    // discard-only
  ['2001::', 32],                   // Teredo
  ['2001:db8::', 32],               // documentation
  ['2002::', 16],                   // 6to4
  ['fc00::', 7, 'LAN'],             // unique local
  ['fe80::', 10, 'LAN'],            // link-local
  ['ff00::', 8],                    // multicast
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

/**
 * "LAN", "loopback" or "CGNAT" for a destination in one of those ranges, else
 * null -- including for anything that is not an IP literal.
 */
function networkName(address) {
  const value = String(address == null ? '' : address).trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(value);
  if (family === 4) {
    const asInt = ipv4ToInt(value);
    if (asInt === null) return null;
    const range = SPECIAL_USE_IPV4.find(([base, bits]) => inIpv4Range(asInt, base, bits));
    return range?.[2] || null;
  }
  if (family !== 6) return null;
  const embedded = value.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (embedded && net.isIP(embedded[1]) === 4) return networkName(embedded[1]);
  const hex = ipv6ToHex(value);
  if (!hex) return null;
  const range = SPECIAL_USE_IPV6.find(([base, bits]) => inIpv6Range(hex, base, bits));
  return range?.[2] || null;
}

const HEX_DIGIT = '[0-9a-fA-F]';
const hexClass = (digits) => {
  const both = digits.flatMap(digit => /[a-f]/.test(digit) ? [digit, digit.toUpperCase()] : [digit]);
  return both.length === 1 ? both[0] : `[${both.join('')}]`;
};

/** GLOB patterns for the decimal numbers lo..hi, one per leading part. */
function decimalGlobs(lo, hi) {
  const byLead = new Map();
  for (let n = lo; n <= hi; n++) {
    const lead = n >= 10 ? String(Math.floor(n / 10)) : '';
    if (!byLead.has(lead)) byLead.set(lead, []);
    byLead.get(lead).push(n % 10);
  }
  return [...byLead].map(([lead, last]) => lead + (last.length === 1
    ? String(last[0]) : `[${last[0]}-${last[last.length - 1]}]`));
}

/** GLOB patterns for the dotted forms inside one IPv4 range. */
function ipv4Globs(base, bits) {
  const octets = base.split('.').map(Number);
  const whole = Math.floor(bits / 8);
  const prefix = octets.slice(0, whole).map(octet => `${octet}.`).join('');
  const rest = bits % 8;
  if (!rest) return [`${prefix}*`];
  const span = 2 ** (8 - rest);
  const start = octets[whole] & ~(span - 1) & 0xff;
  return decimalGlobs(start, start + span - 1).map(octet => `${prefix}${octet}.*`);
}

/**
 * GLOB patterns for one IPv6 range. Only the shapes the named ranges have: a
 * single address, or a prefix inside the first group whose first digit is not
 * zero -- so the group is written with all four digits, and "fd12:" can be
 * matched on its text where "fd:" (0x00fd) must not be.
 */
function ipv6Globs(base, bits) {
  if (bits === 128) return [base];
  const hex = ipv6ToHex(base);
  if (bits > 16 || hex[0] === '0') throw new Error(`no text pattern for ${base}/${bits}`);
  const whole = Math.floor(bits / 4);
  const rest = bits % 4;
  let pattern = [...hex.slice(0, whole)].map(digit => hexClass([digit])).join('');
  if (rest) {
    const span = 2 ** (4 - rest);
    const start = parseInt(hex[whole], 16) & ~(span - 1);
    pattern += hexClass(Array.from({ length: span }, (_, i) => (start + i).toString(16)));
  }
  return [pattern + HEX_DIGIT.repeat(4 - whole - (rest ? 1 : 0)) + ':*'];
}

const NETWORK_NAMES = [...new Set([...SPECIAL_USE_IPV4, ...SPECIAL_USE_IPV6].map(range => range[2]).filter(Boolean))];

/** Whether `address` (an SQL expression) is in the ranges named `name`. */
function inNetworkSql(address, name) {
  const v4 = SPECIAL_USE_IPV4.filter(range => range[2] === name).flatMap(([base, bits]) => ipv4Globs(base, bits));
  const v6 = SPECIAL_USE_IPV6.filter(range => range[2] === name).flatMap(([base, bits]) => ipv6Globs(base, bits));
  const any = (globs) => globs.map(glob => `${address} GLOB '${glob}'`).join(' OR ');
  const terms = [any(v4), any(v6)];
  // IPv4-mapped, behind one test, so an ordinary row pays for it once.
  if (v4.length) terms.push(`(${address} GLOB '::[fF][fF][fF][fF]:*' AND (${any(v4.map(glob => `::[fF][fF][fF][fF]:${glob}`))}))`);
  return `(${terms.filter(Boolean).join(' OR ')})`;
}

/**
 * networkName as SQL over an address held as text: the name, else `fallback`.
 * Built from the same lists as networkName; the tests hold the two to the
 * same answers for addresses written the usual (RFC 5952) way.
 */
function networkNameSql(address, fallback) {
  return `(CASE ${NETWORK_NAMES.map(name => `WHEN ${inNetworkSql(address, name)} THEN '${name}'`).join(' ')} ELSE ${fallback} END)`;
}

/**
 * SQLite's LIKE with ESCAPE '\', in JavaScript: % any run, _ any one
 * character, \ takes the next literally, ASCII letters in either case.
 */
function likeMatches(pattern, text) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) source += escapeRegex(pattern[++i]);
    else if (ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else source += escapeRegex(ch);
  }
  return new RegExp(`^${source}$`, 'i').test(text);
}

function escapeRegex(ch) {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * A condition matching rows whose shown country -- the network name if there
 * is one, else `countryColumn` -- is LIKE `pattern`. Only the names the
 * pattern can match are tested row by row: a JavaScript function in the query
 * cost 2.9 s per million rows, and every name tested for every row 1.5 s.
 * Returns { sql, params }.
 */
function countryLikeSql(address, countryColumn, pattern) {
  const matching = NETWORK_NAMES.filter(name => likeMatches(pattern, name));
  const named = NETWORK_NAMES.map(name => inNetworkSql(address, name)).join(' OR ');
  const terms = [`(${countryColumn} LIKE ? ESCAPE '\\' AND NOT (${named}))`,
    ...matching.map(name => inNetworkSql(address, name))];
  return { sql: `(${terms.join(' OR ')})`, params: [pattern] };
}

module.exports = {
  SPECIAL_USE_IPV4, SPECIAL_USE_IPV6, NETWORK_NAMES,
  isSpecialUseAddress, networkName, networkNameSql, countryLikeSql,
};
