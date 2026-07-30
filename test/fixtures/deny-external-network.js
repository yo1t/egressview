'use strict';

// Phase 3 portability gate: fail before any non-loopback DNS or socket request
// can leave the process. The JSONL trail makes attempted egress diagnosable.
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');

const auditPath = process.env.EGRESSVIEW_EGRESS_AUDIT_PATH;

function record(kind, target) {
  if (auditPath) {
    fs.appendFileSync(auditPath, `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      target: String(target),
    })}\n`, { mode: 0o600 });
  }
  const error = new Error(`External network access blocked: ${kind} ${target}`);
  error.code = 'EGRESSVIEW_EXTERNAL_NETWORK_BLOCKED';
  return error;
}

function isLoopback(value) {
  const host = String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function socketTarget(args) {
  const first = args[0];
  if (typeof first === 'string') return { host: first, local: true };
  if (typeof first === 'number') {
    const host = args[1] || 'localhost';
    return { host, local: isLoopback(host) };
  }
  const options = first || {};
  if (options.path && !options.host && !options.hostname) {
    return { host: options.path, local: true };
  }
  const host = options.host || options.hostname || 'localhost';
  return { host, local: isLoopback(host) };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = socketTarget(args);
  if (!target.local) {
    const error = record('socket', target.host);
    queueMicrotask(() => this.emit('error', error));
    return this;
  }
  return originalConnect.apply(this, args);
};

function guardCallbackLookup(original) {
  return function guardedLookup(hostname, ...args) {
    if (!isLoopback(hostname) && net.isIP(String(hostname)) === 0) {
      const callback = args.findLast((value) => typeof value === 'function');
      const error = record('dns', hostname);
      if (callback) queueMicrotask(() => callback(error));
      return;
    }
    return original.call(this, hostname, ...args);
  };
}

dns.lookup = guardCallbackLookup(dns.lookup);
if (dns.promises?.lookup) {
  const originalPromisesLookup = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = async function guardedPromisesLookup(hostname, ...args) {
    if (!isLoopback(hostname) && net.isIP(String(hostname)) === 0) {
      throw record('dns', hostname);
    }
    return originalPromisesLookup(hostname, ...args);
  };
}

for (const method of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa',
  'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr',
  'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[method] !== 'function') continue;
  const original = dns[method];
  dns[method] = function guardedResolve(hostname, ...args) {
    if (!isLoopback(hostname)) {
      const callback = args.findLast((value) => typeof value === 'function');
      const error = record('dns', hostname);
      if (callback) queueMicrotask(() => callback(error));
      return;
    }
    return original.call(this, hostname, ...args);
  };
}
