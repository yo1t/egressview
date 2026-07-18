// Linux conntrack parser and acquisition contract (P2-31 stage 1).
// SSH lifecycle and settings integration intentionally remain a later stage.
'use strict';

const ACQUISITION_COMMANDS = Object.freeze([
  'cat /proc/net/nf_conntrack',
  'conntrack -L',
]);

const SUPPORTED_PROTOCOLS = new Set(['tcp', 'udp', 'icmp']);

function isPrivateIpv4(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function parseInteger(value, fallback = 0) {
  if (!/^\d+$/.test(String(value || ''))) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function originTuple(tokens, startAt) {
  const tuple = {};
  for (let i = startAt; i < tokens.length; i++) {
    const match = tokens[i].match(/^(src|dst|sport|dport|type|code|id)=(.+)$/);
    if (!match) continue;
    if (match[1] === 'src' && tuple.src) break; // reply tuple starts here
    if (!(match[1] in tuple)) tuple[match[1]] = match[2];
  }
  return tuple;
}

function parseConntrackLine(line) {
  const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens[0].startsWith('conntrack')) return null;

  const protocolIndex = tokens.findIndex(token => SUPPORTED_PROTOCOLS.has(token.toLowerCase()));
  if (protocolIndex < 0) return null;
  if (protocolIndex > 0 && /^ipv6$/i.test(tokens[0])) return null;

  const protocol = tokens[protocolIndex].toLowerCase();
  const timeout = parseInteger(tokens[protocolIndex + 2], 0);
  const firstSrc = tokens.findIndex((token, index) => index > protocolIndex && token.startsWith('src='));
  if (firstSrc < 0) return null;

  const tuple = originTuple(tokens, firstSrc);
  if (!isPrivateIpv4(tuple.src) || !tuple.dst || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tuple.dst)) {
    return null;
  }

  const proto = protocol.toUpperCase();
  if (protocol === 'icmp') {
    return {
      proto,
      src: tuple.src,
      sport: parseInteger(tuple.id, 0),
      dst: tuple.dst,
      dport: 0,
      ttl: timeout,
    };
  }

  const sport = parseInteger(tuple.sport, -1);
  const dport = parseInteger(tuple.dport, -1);
  if (sport < 0 || sport > 65535 || dport < 0 || dport > 65535) return null;
  return { proto, src: tuple.src, sport, dst: tuple.dst, dport, ttl: timeout };
}

function parseConntrack(text) {
  const sessions = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const session = parseConntrackLine(line);
    if (!session) continue;
    const key = `${session.src}|${session.dst}|${session.dport}|${session.proto}`;
    const previous = sessions.get(key);
    if (!previous || session.ttl > previous.ttl) sessions.set(key, session);
  }
  return [...sessions.values()];
}

function classifyConntrackOutput(text) {
  const value = String(text || '');
  if (/permission denied|operation not permitted|must be root/i.test(value)) return 'permission-denied';
  if (/no such file|not found|unknown command/i.test(value)) return 'unavailable';
  return parseConntrack(value).length ? 'supported' : 'empty';
}

module.exports = {
  ACQUISITION_COMMANDS,
  classifyConntrackOutput,
  isPrivateIpv4,
  parseConntrack,
  parseConntrackLine,
};
