// dnsmasq query log poller: tail logs and report client/domain/IP resolutions
'use strict';

const { createTailPoller } = require('./tail-helper');

const DEFAULT_LOG_FILE = '/var/log/dnsmasq-queries.log';
const PENDING_TTL_MS = 60 * 1000;

let logFile       = DEFAULT_LOG_FILE;
let dnsmasqEnabled = true;
let onDnsQuery    = () => {};

const pendingByDomain = new Map();
const cnameRoots = [];

function configure(cfg) {
  if (cfg.logFile    !== undefined) logFile        = cfg.logFile || DEFAULT_LOG_FILE;
  if (cfg.enabled    !== undefined) dnsmasqEnabled = cfg.enabled;
  if (cfg.onDnsQuery)               onDnsQuery     = cfg.onDnsQuery;
}

function parseTime(line) {
  const m = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+/);
  if (!m) return new Date();
  const [, month, day, hour, minute, second] = m;
  const year = new Date().getFullYear();
  const parsed = new Date(`${month} ${parseInt(day, 10)} ${year} ${hour}:${minute}:${second}`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeClientIp(ip) {
  return ip.startsWith('169.254.') ? 'router' : ip;
}

function isIpv4(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split('.').every(part => {
    const n = parseInt(part, 10);
    return n >= 0 && n <= 255 && String(n) === String(parseInt(part, 10));
  });
}

function parseLine(line) {
  const query = line.match(/dnsmasq\[\d+\]: query\[(A|AAAA)\] (\S+) from (\S+)/);
  if (query) {
    return {
      type:     'query',
      qtype:    query[1],
      domain:   query[2],
      clientIp: query[3],
      time:     parseTime(line),
    };
  }

  const reply = line.match(/dnsmasq\[\d+\]: reply (\S+) is (\S+)/);
  if (reply) {
    return {
      type:       'reply',
      domain:     reply[1],
      resolvedIp: isIpv4(reply[2]) ? reply[2] : null,
      rawValue:   reply[2],
    };
  }

  return null;
}

function prunePending() {
  const oldest = Date.now() - PENDING_TTL_MS;
  for (const [domain, items] of pendingByDomain) {
    const active = items.filter(item => item.createdAt >= oldest);
    if (active.length) pendingByDomain.set(domain, active);
    else pendingByDomain.delete(domain);
  }
  for (let i = cnameRoots.length - 1; i >= 0; i--) {
    if (cnameRoots[i].createdAt < oldest || !hasPending(cnameRoots[i].domain)) {
      cnameRoots.splice(i, 1);
    }
  }
}

function queueQuery(entry) {
  prunePending();
  const item = {
    domain:   entry.domain,
    qtype:    entry.qtype,
    clientIp: normalizeClientIp(entry.clientIp),
    time:     entry.time,
    createdAt: Date.now(),
  };
  if (!pendingByDomain.has(entry.domain)) pendingByDomain.set(entry.domain, []);
  pendingByDomain.get(entry.domain).push(item);
}

function hasPending(domain) {
  const items = pendingByDomain.get(domain);
  return !!items && items.length > 0;
}

function takePending(domain, preferredType) {
  const items = pendingByDomain.get(domain);
  if (!items || !items.length) return null;
  let idx = -1;
  if (preferredType) idx = items.findIndex(item => item.qtype === preferredType);
  if (idx < 0) idx = 0;
  const item = items.splice(idx, 1)[0];
  if (!items.length) pendingByDomain.delete(domain);
  return item;
}

function emitQuery(query, resolvedIp) {
  try {
    onDnsQuery({ clientIp: query.clientIp, domain: query.domain, resolvedIp, time: query.time });
  } catch (e) {
    console.error('[dnsmasq-log] onDnsQuery failed:', e.message);
  }
}

function rememberCnameRoot(domain) {
  if (!hasPending(domain)) return;
  if (!cnameRoots.some(root => root.domain === domain)) {
    cnameRoots.push({ domain, createdAt: Date.now() });
  }
}

function takeCnameRoot() {
  prunePending();
  while (cnameRoots.length) {
    const root = cnameRoots.shift();
    if (hasPending(root.domain)) return root.domain;
  }
  return null;
}

function resolveDirectReply(entry) {
  if (entry.rawValue === '<CNAME>') { rememberCnameRoot(entry.domain); return true; }
  if (entry.rawValue === 'NODATA-IPv6') {
    const query = takePending(entry.domain, 'AAAA');
    if (query) emitQuery(query, null);
    return !!query;
  }
  const preferredType = entry.resolvedIp ? 'A' : null;
  const query = takePending(entry.domain, preferredType);
  if (!query) return false;
  emitQuery(query, entry.resolvedIp);
  return true;
}

function resolveCnameReply(entry) {
  if (entry.rawValue === '<CNAME>') return false;
  const rootDomain = takeCnameRoot();
  if (!rootDomain) return false;
  const preferredType = entry.resolvedIp ? 'A' : null;
  const query = takePending(rootDomain, preferredType);
  if (!query) return false;
  emitQuery(query, entry.resolvedIp);
  return true;
}

function handleEntry(entry) {
  if (entry.type === 'query') { queueQuery(entry); return; }
  if (entry.type === 'reply') {
    if (resolveDirectReply(entry)) return;
    resolveCnameReply(entry);
  }
}

const poller = createTailPoller({
  name:       'dnsmasq-log',
  getLogFile: () => logFile,
  isEnabled:  () => dnsmasqEnabled,
  onLine: line => {
    const entry = parseLine(line);
    if (!entry) return;
    handleEntry(entry);
  },
});

function stop() {
  poller.stop();
  pendingByDomain.clear();
  cnameRoots.length = 0;
}

module.exports = {
  configure,
  start: poller.start,
  stop,
  _parseLine: parseLine,
};
