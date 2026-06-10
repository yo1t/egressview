// Routes: beacon detection results
'use strict';

const { Router } = require('express');
const { parsePositiveInt } = require('../utils');

/**
 * @param {{ requireAdmin, beacons }} ctx
 */
function beaconsRoutes(ctx) {
  const { requireAdmin, beacons } = ctx;
  const router = Router();

  // GET /api/beacons — return all beacon candidates (excluding dismissed)
  router.get('/beacons', requireAdmin, (req, res) => {
    const all = beacons.getBeacons();
    const includeDismissed = req.query.includeDismissed === '1';
    const results = includeDismissed ? all : all.filter(b => b.status !== 'dismissed');
    res.json({ beacons: results });
  });

  // POST /api/beacons/:id/dismiss — dismiss a beacon candidate
  router.post('/beacons/:id/dismiss', requireAdmin, (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid id' });
    const ok = beacons.dismissBeacon(id);
    if (!ok) return res.status(404).json({ error: 'beacon not found' });
    res.json({ success: true });
  });

  return router;
}

module.exports = beaconsRoutes;
