// Common contract for router poller adapters.
'use strict';

const REQUIRED_METHODS = [
  'configure',
  'connect',
  'disconnect',
  'reconnect',
  'isEnabled',
  'isReady',
  'fetchSessions',
  'refreshArp',
  'refreshNdp',
  'needsArpRefresh',
  'needsNdpRefresh',
  'getArpCache',
  'getArpMac',
  'getNdpByMac',
  'getIp',
  'getUser',
  'hasPass',
  'getNat',
  'getHostFp',
  'exec',
  'detect',
  'detectCurrent',
];

function validateRouterPoller(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('router poller adapter must be an object');
  }
  if (!adapter.kind || typeof adapter.kind !== 'string') {
    throw new TypeError('router poller adapter must provide a string kind');
  }
  for (const name of REQUIRED_METHODS) {
    if (typeof adapter[name] !== 'function') {
      throw new TypeError(`router poller adapter "${adapter.kind}" is missing method: ${name}`);
    }
  }
  return adapter;
}

function createRouterPoller(adapter) {
  return validateRouterPoller(Object.freeze({ ...adapter }));
}

module.exports = {
  REQUIRED_METHODS,
  createRouterPoller,
  validateRouterPoller,
};
