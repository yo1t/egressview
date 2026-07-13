'use strict';

function buildClientConfig({
  appState,
  asus,
  yamaha,
  cisco,
  notes,
  defaultRouterIp,
  routers = [],
}) {
  return {
    routerIp:        asus.getRouterIp() || defaultRouterIp,
    asusUser:        asus.getUser(),
    asusPassSet:     asus.hasPass(),
    authenticated:   asus.isAuthenticated(),
    asusEnabled:     asus.isEnabled(),
    yamahaEnabled:   yamaha.isEnabled(),
    yamahaIp:        yamaha.getIp(),
    yamahaUser:      yamaha.getUser(),
    yamahaNat:       yamaha.getNat(),
    yamahaPassSet:   yamaha.hasPass(),
    yamahaReady:     yamaha.isReady(),
    ciscoEnabled:    cisco.isEnabled(),
    ciscoIp:         cisco.getIp(),
    ciscoUser:       cisco.getUser(),
    ciscoPassSet:    cisco.hasPass(),
    ciscoReady:      cisco.isReady(),
    homeCountry:     appState.homeCountry,
    language:        appState.uiLanguage,
    autoInvestigate: appState.autoInvestigate,
    retentionDays:   appState.retentionDays,
    notes:           notes.getAll(),
    dnsmasqEnabled:  appState.dnsmasqEnabled,
    dnsmasqLogFile:  appState.dnsmasqLogFile,
    inspectEnabled:  appState.inspectEnabled,
    inspectLogFile:  appState.inspectLogFile,
    dhcpdEnabled:    appState.dhcpdEnabled,
    dhcpdLogFile:    appState.dhcpdLogFile,
    routers,
  };
}

function registerSocketHandlers({
  io,
  appState,
  authenticate,
  asus,
  yamaha,
  cisco,
  notes,
  history,
  threatIntel,
  defaultRouterIp,
  logger = console,
  now = () => Date.now(),
  getRouters = () => [],
}) {
  io.use((socket, next) => {
    const provided = String(socket.handshake.auth?.token || '');
    if (!appState.adminToken) return next(new Error('認証未初期化'));
    if (!authenticate(provided)) return next(new Error('Unauthorized'));
    next();
  });

  io.on('connection', socket => {
    logger.debug('[ws] Client connected:', socket.id);
    socket.emit('config', buildClientConfig({
      appState,
      asus,
      yamaha,
      cisco,
      notes,
      defaultRouterIp,
      routers: getRouters(),
    }));

    if (asus.isEnabled() && !asus.isAuthenticated()) {
      socket.emit('auth-required', { message: 'セッションが切れています' });
    }

    const connectionHistory = history.getConnectionHistory();
    if ((getRouters().some(router => router.enabled) || yamaha.isEnabled() || cisco.isEnabled()) && connectionHistory.size) {
      const serverTime = now();
      const cutoff = serverTime - 3_600_000;
      let recentConnections = typeof history.queryByTimeRange === 'function'
        ? history.queryByTimeRange(cutoff, serverTime)
        : [...connectionHistory.values()].filter(c => c.lastSeen >= cutoff);
      if (threatIntel?.matchThreatIntel) {
        recentConnections = recentConnections.map(entry => ({
          ...entry,
          threat: threatIntel.matchThreatIntel(entry.dst, entry.dstHost || entry.dst) || null,
        }));
      }
      socket.emit('connections-update', {
        connections: recentConnections,
        serverTime,
        partial: true,
        initialLoad: true,
      });
    }
  });
}

module.exports = {
  buildClientConfig,
  registerSocketHandlers,
};
