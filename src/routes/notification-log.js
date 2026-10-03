// Routes: notification / detection log
'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { parseTimestamp } = require('../utils');
const { createHistoryReader } = require('../history-reader');
const {
  sourceScopeShape, validateSourceScopePair, requireKnownSourceScope,
} = require('../source-scope');

const timestampQuery = z.union([
  z.string().max(20),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]).optional();
const notificationLogQuerySchema = z.object({
  from: timestampQuery,
  to: timestampQuery,
  ...sourceScopeShape,
}).strict().superRefine(validateSourceScopePair);

/**
 * @param {{ requireAdmin, history }} ctx
 */
module.exports = function notificationLogRoutes(ctx) {
  const { requireAdmin, history, routerManager, agentIdentities } = ctx;
  // Scoped to a source, this read took 24.9 s on 2026-10-03; it goes to the
  // read thread when the server has one (P3-184).
  const reader = ctx.historyReader || createHistoryReader({ history });
  const router = Router();

  router.get('/notification-log', requireAdmin, async (req, res) => {
    const parsed = parseRequest(notificationLogQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const scoped = requireKnownSourceScope(parsed.data, { routerManager, agentIdentities }, res);
    if (!scoped.ok) return;
    const { from: fromRaw, to: toRaw } = parsed.data;
    const from = parseTimestamp(fromRaw);
    const to   = parseTimestamp(toRaw);
    if (fromRaw != null && fromRaw !== '' && from === null)
      return res.status(400).json({ error: 'invalid "from" timestamp' });
    if (toRaw   != null && toRaw   !== '' && to   === null)
      return res.status(400).json({ error: 'invalid "to" timestamp' });
    const logs = await reader.read('queryNotificationLog', from, to, { sourceScope: scoped.scope });
    res.json({ logs, serverTime: Date.now() });
  });

  return router;
};
