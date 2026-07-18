'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const PROCESS_STARTED_AT = Date.now();

const routerBodySchema = z.object({
  kind: z.enum(['yamaha', 'cisco']).optional(),
  displayName: z.string().max(80).optional(),
  ip: z.string().max(255).optional(),
  user: z.string().max(255).optional(),
  pass: z.string().max(4096).optional(),
  enablePass: z.string().max(4096).optional(),
  nat: z.union([z.string(), z.number()]).optional(),
  enabled: z.boolean().optional(),
}).strict();
const routerIdSchema = z.object({ id: z.string().min(1).max(128) }).strict();

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
    const parsed = parseRequest(routerBodySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      const result = await routerManager.detect(parsed.data);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(502).json({ success: false, error: err.message, diag: err.diag || null });
    }
  });

  router.post('/routers', requireAdmin, (req, res) => {
    const parsed = parseRequest(routerBodySchema, req.body, res);
    if (!parsed.ok) return;
    try {
      const created = routerManager.upsert({ ...parsed.data, id: undefined });
      res.status(201).json({ success: true, router: created });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.put('/routers/:id', requireAdmin, (req, res) => {
    const params = parseRequest(routerIdSchema, req.params, res);
    if (!params.ok) return;
    const body = parseRequest(routerBodySchema, req.body, res);
    if (!body.ok) return;
    try {
      const updated = routerManager.upsert({ ...body.data, id: params.data.id });
      res.json({ success: true, router: updated });
    } catch (err) {
      const status = /not found/.test(err.message) ? 404 : 400;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  router.delete('/routers/:id', requireAdmin, (req, res) => {
    const parsed = parseRequest(routerIdSchema, req.params, res);
    if (!parsed.ok) return;
    if (!routerManager.remove(parsed.data.id)) return res.status(404).json({ error: 'router not found' });
    res.json({ success: true });
  });

  return router;
};
