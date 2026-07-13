// Yamaha RTX implementation of the router poller contract.
'use strict';

const { createRouterPoller } = require('./router-interface');
const yamaha = require('./yamaha');

/**
 * Wrap a Yamaha poller instance in the router poller contract.
 * @param {{ id?: string }} [opts]  routerId; omit for the legacy singleton
 */
function createYamahaAdapter({ id = '' } = {}) {
  const poller = id ? yamaha.createYamahaPoller({ id }) : yamaha;
  return createRouterPoller({
    kind: 'yamaha',
    label: 'Yamaha RTX',
    id,

    configure: poller.configure,
    connect: poller.connectYamaha,
    disconnect: poller.disconnect,
    reconnect: poller.reconnect,
    isEnabled: poller.isEnabled,
    isReady: poller.isReady,

    fetchSessions: poller.fetchNatSessions,
    refreshArp: poller.refreshYamahaArp,
    refreshNdp: poller.refreshYamahaNdp,
    needsArpRefresh: poller.needsArpRefresh,
    needsNdpRefresh: poller.needsNdpRefresh,
    getArpCache: poller.getArpCache,
    getArpMac: poller.getArpMac,
    getNdpByMac: poller.getNdpByMac,

    getIp: poller.getIp,
    getUser: poller.getUser,
    hasPass: poller.hasPass,
    getNat: poller.getNat,
    getHostFp: poller.getHostFp,

    exec: poller.yamahaExec,
    detect: poller.detectYamaha,
    detectCurrent: poller.detectCurrentYamaha,
  });
}

const adapter = createYamahaAdapter();

module.exports = {
  ...adapter,
  createYamahaAdapter,

  // Backward-compatible Yamaha names used by current routes and helpers.
  connectYamaha: adapter.connect,
  fetchNatSessions: adapter.fetchSessions,
  refreshYamahaArp: adapter.refreshArp,
  refreshYamahaNdp: adapter.refreshNdp,
  yamahaExec: adapter.exec,
  detectYamaha: adapter.detect,
  detectCurrentYamaha: adapter.detectCurrent,

  // Parser helpers remain Yamaha-specific and are intentionally exposed for tests.
  parseNatDetail: yamaha.parseNatDetail,
  parseNatDescriptorCandidates: yamaha.parseNatDescriptorCandidates,
  parseLanIp: yamaha.parseLanIp,

  _legacy: yamaha,
};
