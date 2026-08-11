// Routes: device inventory + merge candidates
'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { t } = require('../i18n-server');
const logger = require('../logger');
const {
  sourceScopeShape, validateSourceScopePair, requireKnownSourceScope,
} = require('../source-scope');

const deviceId = z.string().min(1).max(128);
const devicesQuerySchema = z.object({
  includeArchived: z.enum(['0', '1']).optional(),
  ...sourceScopeShape,
}).strict().superRefine(validateSourceScopePair);
const mergeCandidatesQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional(),
}).strict();
const mergeSchema = z.object({ keepId: deviceId, dropId: deviceId }).strict();
const candidateId = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+$/).max(16),
]).transform(Number).refine(Number.isSafeInteger);
const rejectSchema = z.object({ id: candidateId }).strict();
const archiveSchema = z.object({ deviceId }).strict();

/**
 * @param {{
 *   requireAdmin,
 *   devices: import('../devices'),
 *   notes:   import('../notes'),
 *   yamaha
 * }} ctx
 */
module.exports = function devicesRoutes(ctx) {
  const { requireAdmin, devices, notes, yamaha, history, routerManager, agentIdentities } = ctx;
  const router = Router();

  // GET /api/devices[?includeArchived=1]
  // Returns devices with status (active/recent/stale/archived), IPv6, and notes.
  router.get('/devices', requireAdmin, (req, res) => {
    const parsed = parseRequest(devicesQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const scoped = requireKnownSourceScope(parsed.data, { routerManager, agentIdentities }, res);
    if (!scoped.ok) return;
    const includeArchived = parsed.data.includeArchived === '1';
    let all = devices.getAll({ includeArchived });
    if (scoped.scope && typeof history?.listSourceDeviceKeys === 'function') {
      const keys = history.listSourceDeviceKeys(scoped.scope);
      const ips = new Set(keys.map(row => row.src).filter(Boolean));
      const macs = new Set(keys.map(row => row.srcMac?.toLowerCase()).filter(Boolean));
      all = all.filter(device => ips.has(device.ip) || macs.has(device.mac?.toLowerCase()));
    }
    for (const d of all) {
      d.ipv6Addrs = d.mac ? (yamaha.getNdpByMac(d.mac) || null) : null;
      d.note = notes
        ? notes.getForDevice(d.deviceId, d.ip, d.mac) || null
        : null;
    }
    res.json({ devices: all });
  });

  // GET /api/devices/merge-candidates?status=pending
  router.get('/devices/merge-candidates', requireAdmin, (req, res) => {
    const parsed = parseRequest(mergeCandidatesQuerySchema, req.query, res);
    if (!parsed.ok) return;
    const status = parsed.data.status || 'pending';
    const candidates = devices.getMergeCandidates(status);
    // Parse reasons JSON for convenience
    for (const c of candidates) {
      try { c.reasons = JSON.parse(c.reasons); } catch { c.reasons = []; }
    }
    res.json({ candidates });
  });

  // POST /api/devices/merge  — approve a merge candidate
  // Body: { keepId, dropId }
  router.post('/devices/merge', requireAdmin, (req, res) => {
    const parsed = parseRequest(mergeSchema, req.body, res, { error: t('device.merge-missing-id') });
    if (!parsed.ok) return;
    const { keepId, dropId } = parsed.data;
    if (keepId === dropId) {
      return res.status(400).json({ error: t('device.merge-same-id') });
    }
    if (!devices.getByDeviceId(keepId) || !devices.getByDeviceId(dropId)) {
      return res.status(404).json({ error: t('device.not-found') });
    }

    // Migrate note from dropId to keepId (if dropId had a note and keepId does not)
    let previousNotes = null;
    if (notes) {
      const dropNote = notes.get(dropId);
      const keepNote = notes.get(keepId);
      if (dropNote && !keepNote) {
        previousNotes = notes.snapshot();
        notes.set(keepId, dropNote);
        notes.del(dropId);
        try {
          notes.save();
        } catch (e) {
          notes.restore(previousNotes);
          logger.error(`[devices] Note migration failed before merging ${dropId} into ${keepId}: ${e.message}`);
          return res.status(500).json({ error: t('common.internal-error') });
        }
      }
    }

    try {
      const ok = devices.approveMerge(keepId, dropId);
      if (!ok) throw new Error('Device merge precondition changed');
    } catch (e) {
      if (previousNotes) {
        notes.restore(previousNotes);
        try {
          notes.save();
        } catch (rollbackError) {
          logger.error(`[devices] Failed to persist note rollback: ${rollbackError.message}`);
        }
      }
      logger.error(`[devices] Merge failed for ${dropId} into ${keepId}: ${e.message}`);
      return res.status(500).json({ error: t('common.internal-error') });
    }
    res.json({ success: true });
  });

  // POST /api/devices/reject  — reject a merge candidate
  // Body: { id }
  router.post('/devices/reject', requireAdmin, (req, res) => {
    const parsed = parseRequest(rejectSchema, req.body, res, { error: t('device.id-required') });
    if (!parsed.ok) return;
    const { id } = parsed.data;
    devices.rejectCandidate(id);
    res.json({ success: true });
  });

  // POST /api/devices/archive  — manually archive a device
  // Body: { deviceId }
  router.post('/devices/archive', requireAdmin, (req, res) => {
    const parsed = parseRequest(archiveSchema, req.body, res, { error: t('device.device-id-required') });
    if (!parsed.ok) return;
    const { deviceId } = parsed.data;
    const ok = devices.archiveDevice(deviceId);
    if (!ok) return res.status(404).json({ error: t('device.already-archived') });
    res.json({ success: true });
  });

  // POST /api/devices/unarchive  — restore an archived device
  // Body: { deviceId }
  router.post('/devices/unarchive', requireAdmin, (req, res) => {
    const parsed = parseRequest(archiveSchema, req.body, res, { error: t('device.device-id-required') });
    if (!parsed.ok) return;
    const { deviceId } = parsed.data;
    const ok = devices.unarchiveDevice(deviceId);
    if (!ok) return res.status(404).json({ error: t('device.not-found') });
    res.json({ success: true });
  });

  return router;
};
