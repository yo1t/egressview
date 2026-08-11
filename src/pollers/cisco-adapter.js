// Cisco IOS implementation of the router poller contract.
'use strict';

const { createRouterPoller } = require('./router-interface');
const cisco = require('./cisco');

/**
 * Wrap a Cisco poller instance in the router poller contract.
 * @param {{ id?: string }} [opts]  routerId; omit for the legacy singleton
 */
function createCiscoAdapter({ id = '' } = {}) {
  const poller = id ? cisco.createCiscoPoller({ id }) : cisco;
  return createRouterPoller({
    kind: 'cisco',
    label: 'Cisco IOS',
    id,

    configure: poller.configure,
    connect: poller.connectCisco,
    disconnect: poller.disconnect,
    reconnect: poller.reconnect,
    isEnabled: poller.isEnabled,
    isReady: poller.isReady,

    fetchSessions: poller.fetchNatSessions,
    refreshArp: poller.refreshCiscoArp,
    refreshNdp: poller.refreshCiscoNdp,
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
    getHostName: poller.getHostName,

    exec: poller.ciscoExec,
    detect: poller.detectCisco,
    detectCurrent: poller.detectCurrentCisco,
  });
}

const adapter = createCiscoAdapter();

module.exports = {
  ...adapter,
  createCiscoAdapter,

  // Parser helpers exposed for tests.
  parseNatTranslations: cisco.parseNatTranslations,
  parseArp: cisco.parseArp,
  parseNdpNeighbors: cisco.parseNdpNeighbors,
  parseLanIp: cisco.parseLanIp,
  parseNatInsideInterfaces: cisco.parseNatInsideInterfaces,
  dotMacToColon: cisco.dotMacToColon,
  isCiscoIos: cisco.isCiscoIos,
  isPrivilegeError: cisco.isPrivilegeError,
  extractCiscoHostName: cisco.extractCiscoHostName,

  _legacy: cisco,
};
