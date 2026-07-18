'use strict';

const { createRouterPoller } = require('./router-interface');
const { createConntrackPoller } = require('./conntrack-poller');

function createConntrackAdapter({ id = '', pollerOptions = {} } = {}) {
  const poller = createConntrackPoller({ id, ...pollerOptions });
  return createRouterPoller({
    kind: 'conntrack',
    label: 'Linux conntrack',
    id,
    configure: poller.configure,
    connect: poller.connect,
    disconnect: poller.disconnect,
    reconnect: poller.reconnect,
    isEnabled: poller.isEnabled,
    isReady: poller.isReady,
    fetchSessions: poller.fetchSessions,
    refreshArp: poller.refreshArp,
    refreshNdp: poller.refreshNdp,
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
    exec: poller.exec,
    detect: poller.detect,
    detectCurrent: poller.detectCurrent,
  });
}

module.exports = { createConntrackAdapter };
