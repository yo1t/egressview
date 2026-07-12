// Cisco IOS implementation of the router poller contract.
'use strict';

const { createRouterPoller } = require('./router-interface');
const cisco = require('./cisco');

const adapter = createRouterPoller({
  kind: 'cisco',
  label: 'Cisco IOS',

  configure: cisco.configure,
  connect: cisco.connectCisco,
  disconnect: cisco.disconnect,
  reconnect: cisco.reconnect,
  isEnabled: cisco.isEnabled,
  isReady: cisco.isReady,

  fetchSessions: cisco.fetchNatSessions,
  refreshArp: cisco.refreshCiscoArp,
  refreshNdp: cisco.refreshCiscoNdp,
  needsArpRefresh: cisco.needsArpRefresh,
  needsNdpRefresh: cisco.needsNdpRefresh,
  getArpCache: cisco.getArpCache,
  getArpMac: cisco.getArpMac,
  getNdpByMac: cisco.getNdpByMac,

  getIp: cisco.getIp,
  getUser: cisco.getUser,
  hasPass: cisco.hasPass,
  getNat: cisco.getNat,
  getHostFp: cisco.getHostFp,

  exec: cisco.ciscoExec,
  detect: cisco.detectCisco,
  detectCurrent: cisco.detectCurrentCisco,
});

module.exports = {
  ...adapter,

  // Parser helpers exposed for tests.
  parseNatTranslations: cisco.parseNatTranslations,
  parseArp: cisco.parseArp,
  parseNdpNeighbors: cisco.parseNdpNeighbors,
  parseLanIp: cisco.parseLanIp,
  parseNatInsideInterfaces: cisco.parseNatInsideInterfaces,
  dotMacToColon: cisco.dotMacToColon,
  isCiscoIos: cisco.isCiscoIos,
  isPrivilegeError: cisco.isPrivilegeError,

  _legacy: cisco,
};
