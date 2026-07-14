'use strict';

const { Router } = require('express');
const PROCESS_STARTED_AT = Date.now();

module.exports = function routerRoutes({ requireAdmin, routerManager }) {
  const router = Router();

  router.get('/routers', requireAdmin, (_req, res) => {
    res.json({
      routers: routerManager.list(),
      maxRouters: 10,
      serverTime: Date.now(),
      processStartedAt: PROCESS_STARTED_AT,
    });
  });

  router.post('/routers/detect', requireAdmin, async (req, res) => {
    try {
      const result = await routerManager.detect(req.body || {});
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message, diag: err.diag || null });
    }
  });

  router.post('/routers', requireAdmin, (req, res) => {
    try {
      const created = routerManager.upsert({ ...(req.body || {}), id: undefined });
      res.status(201).json({ success: true, router: created });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.put('/routers/:id', requireAdmin, (req, res) => {
    try {
      const updated = routerManager.upsert({ ...(req.body || {}), id: req.params.id });
      res.json({ success: true, router: updated });
    } catch (err) {
      const status = /not found/.test(err.message) ? 404 : 400;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  router.delete('/routers/:id', requireAdmin, (req, res) => {
    if (!routerManager.remove(req.params.id)) return res.status(404).json({ error: 'router not found' });
    res.json({ success: true });
  });

  return router;
};
