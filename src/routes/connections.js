// Routes: connection history query
'use strict';

const { Router } = require('express');

function attachThreats(connections, threatIntel) {
  if (!threatIntel || typeof threatIntel.matchThreatIntel !== 'function') return connections;
  return connections.map(c => ({
    ...c,
    threat: threatIntel.matchThreatIntel(c.dst, c.dstHost || c.dst) || null,
  }));
}

/**
 * @param {{ requireAdmin, history, threatIntel? }} ctx
 */
function connectionsRoutes(ctx) {
  const { requireAdmin, history, threatIntel } = ctx;
  const router = Router();

  router.get('/connections', requireAdmin, (req, res) => {
    const from = req.query.from != null && req.query.from !== '' ? parseInt(req.query.from) : null;
    const to   = req.query.to   != null && req.query.to   !== '' ? parseInt(req.query.to)   : null;
    const connections = attachThreats(history.queryByTimeRange(from, to), threatIntel);
    res.json({ connections, serverTime: Date.now() });
  });

  return router;
}

module.exports = connectionsRoutes;
module.exports._attachThreats = attachThreats;
