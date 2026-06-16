// Routes: notification / detection log
'use strict';

const { Router } = require('express');
const { parseTimestamp } = require('../utils');

/**
 * @param {{ requireAdmin, history }} ctx
 */
module.exports = function notificationLogRoutes(ctx) {
  const { requireAdmin, history } = ctx;
  const router = Router();

  router.get('/notification-log', requireAdmin, (req, res) => {
    const from = parseTimestamp(req.query.from);
    const to   = parseTimestamp(req.query.to);
    if (req.query.from != null && req.query.from !== '' && from === null)
      return res.status(400).json({ error: 'invalid "from" timestamp' });
    if (req.query.to   != null && req.query.to   !== '' && to   === null)
      return res.status(400).json({ error: 'invalid "to" timestamp' });
    res.json({ logs: history.queryNotificationLog(from, to), serverTime: Date.now() });
  });

  return router;
};
