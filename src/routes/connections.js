// Routes: connection history query
'use strict';

const { Router } = require('express');
const { parseTimestamp } = require('../utils');

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
    const from = parseTimestamp(req.query.from);
    const to   = parseTimestamp(req.query.to);
    if (req.query.from != null && req.query.from !== '' && from === null)
      return res.status(400).json({ error: 'invalid "from" timestamp' });
    if (req.query.to   != null && req.query.to   !== '' && to   === null)
      return res.status(400).json({ error: 'invalid "to" timestamp' });
    const connections = attachThreats(history.queryByTimeRange(from, to), threatIntel);
    res.json({ connections, serverTime: Date.now() });
  });

  return router;
}

module.exports = connectionsRoutes;
module.exports._attachThreats = attachThreats;
