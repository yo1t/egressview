// Yamaha RTX implementation of the router poller contract.
'use strict';

const { createRouterPoller } = require('./router-interface');
const yamaha = require('./yamaha');

const adapter = createRouterPoller({
  kind: 'yamaha',
  label: 'Yamaha RTX',

  configure: yamaha.configure,
  connect: yamaha.connectYamaha,
  disconnect: yamaha.disconnect,
  reconnect: yamaha.reconnect,
  isEnabled: yamaha.isEnabled,
  isReady: yamaha.isReady,

  fetchSessions: yamaha.fetchNatSessions,
  refreshArp: yamaha.refreshYamahaArp,
  refreshNdp: yamaha.refreshYamahaNdp,
  needsArpRefresh: yamaha.needsArpRefresh,
  needsNdpRefresh: yamaha.needsNdpRefresh,
  getArpCache: yamaha.getArpCache,
  getArpMac: yamaha.getArpMac,
  getNdpByMac: yamaha.getNdpByMac,

  getIp: yamaha.getIp,
  getUser: yamaha.getUser,
  hasPass: yamaha.hasPass,
  getNat: yamaha.getNat,
  getHostFp: yamaha.getHostFp,

  exec: yamaha.yamahaExec,
  detect: yamaha.detectYamaha,
  detectCurrent: yamaha.detectCurrentYamaha,
});

module.exports = {
  ...adapter,

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
