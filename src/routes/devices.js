// Routes: device inventory + merge candidates
'use strict';

const { Router } = require('express');

/**
 * @param {{
 *   requireAdmin,
 *   devices: import('../devices'),
 *   notes:   import('../notes'),
 *   yamaha
 * }} ctx
 */
module.exports = function devicesRoutes(ctx) {
  const { requireAdmin, devices, notes, yamaha } = ctx;
  const router = Router();

  // GET /api/devices[?includeArchived=1]
  // Returns devices with status (active/recent/stale/archived), IPv6, and notes.
  router.get('/devices', requireAdmin, (req, res) => {
    const includeArchived = req.query.includeArchived === '1';
    const all = devices.getAll({ includeArchived });
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
    const status = ['pending', 'approved', 'rejected', 'all']
      .includes(req.query.status) ? req.query.status : 'pending';
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
    const { keepId, dropId } = req.body || {};
    if (!keepId || !dropId) {
      return res.status(400).json({ error: 'keepId と dropId が必要です' });
    }
    if (keepId === dropId) {
      return res.status(400).json({ error: 'keepId と dropId は異なる必要があります' });
    }

    // Migrate note from dropId to keepId (if dropId had a note and keepId does not)
    if (notes) {
      const dropNote = notes.get(dropId);
      const keepNote = notes.get(keepId);
      if (dropNote && !keepNote) {
        notes.set(keepId, dropNote);
        notes.del(dropId);
        notes.save();
      }
    }

    const ok = devices.approveMerge(keepId, dropId);
    if (!ok) return res.status(404).json({ error: 'デバイスが見つかりません' });
    res.json({ success: true });
  });

  // POST /api/devices/reject  — reject a merge candidate
  // Body: { id }
  router.post('/devices/reject', requireAdmin, (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id が必要です' });
    devices.rejectCandidate(id);
    res.json({ success: true });
  });

  // POST /api/devices/archive  — manually archive a device
  // Body: { deviceId }
  router.post('/devices/archive', requireAdmin, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId が必要です' });
    const ok = devices.archiveDevice(deviceId);
    if (!ok) return res.status(404).json({ error: 'デバイスが見つからないか既にアーカイブ済みです' });
    res.json({ success: true });
  });

  // POST /api/devices/unarchive  — restore an archived device
  // Body: { deviceId }
  router.post('/devices/unarchive', requireAdmin, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId が必要です' });
    const ok = devices.unarchiveDevice(deviceId);
    if (!ok) return res.status(404).json({ error: 'デバイスが見つかりません' });
    res.json({ success: true });
  });

  return router;
};
