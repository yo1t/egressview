// Routes: notes CRUD and on-demand investigation
'use strict';

const { Router } = require('express');
const { isAllowedRouterIp } = require('../utils');
const logger = require('../logger');

/**
 * @param {{
 *   requireAdmin,
 *   notes: import('../notes'),
 *   devices: import('../devices'),
 *   io,
 *   yamaha, deviceId
 * }} ctx
 */
module.exports = function notesRoutes(ctx) {
  const { requireAdmin, notes, devices, io, yamaha, deviceId } = ctx;
  const router = Router();

  // GET /api/notes
  router.get('/notes', requireAdmin, (req, res) => {
    res.json({ notes: notes.getAll() });
  });

  // POST /api/notes
  // Accepts { ip, mac, note } (legacy) or { deviceId, note } (new canonical form).
  // When ip/mac is provided and the device has a deviceId in the inventory,
  // the note is stored under deviceId (step 8: notes follow the device, not the IP).
  router.post('/notes', requireAdmin, (req, res) => {
    const { ip, mac, note, deviceId: reqDeviceId } = req.body || {};

    // ── Resolve canonical key ──────────────────────────────────────────────
    let canonicalId = reqDeviceId || null;

    // Auto-lookup deviceId from devices table when ip/mac is provided
    if (!canonicalId && devices) {
      const device = ip ? devices.getByIp(ip)
                       : (mac ? devices.getByMac(mac)?.[0] : null);
      canonicalId = device?.deviceId || null;
    }

    let key = canonicalId || '';
    if (!key) {
      if (ip && mac)        key = `${ip}|${mac}`;
      else if (ip)          key = ip;
      else if (mac)         key = mac;
      else if (req.body?.key) key = req.body.key;
    }

    if (!notes.isSafeKey(key)) {
      return res.status(400).json({ error: 'invalid key (IP/MAC または deviceId 形式のみ)' });
    }

    // ── Migrate old IP/MAC note to deviceId key ────────────────────────────
    if (canonicalId && (ip || mac)) {
      const oldKey = ip && mac ? `${ip}|${mac}` : (ip || mac);
      const oldNote = notes.get(oldKey);
      if (oldNote && !notes.get(canonicalId)) {
        notes.set(canonicalId, oldNote);
      }
      // Remove stale IP/MAC-keyed copies
      if (ip || mac) notes.clearByIpMac(ip, mac);
    }

    // ── Write ──────────────────────────────────────────────────────────────
    if (typeof note === 'string') {
      const trimmed = note.trim().substring(0, 500);
      if (trimmed) {
        notes.set(key, trimmed);
      } else {
        notes.del(key);
        // Also clean up any remaining IP/MAC entries for this device
        if (ip || mac) notes.clearByIpMac(ip, mac);
      }
    }

    notes.save();
    io.emit('notes-update', { notes: notes.getAll() });
    res.json({ success: true });
  });

  // POST /api/notes/draft  — on-demand investigation
  router.post('/notes/draft', requireAdmin, async (req, res) => {
    const ip = req.body?.ip;
    if (!ip || !isAllowedRouterIp(ip)) {
      return res.status(400).json({ error: '有効なプライベートIPを指定してください' });
    }
    try {
      const result = await deviceId.investigateIp(ip, {
        ouiDb:         deviceId.getOuiDb(),
        yamahaExec:    yamaha.isReady() ? yamaha.yamahaExec : null,
        yamahaEnabled: yamaha.isEnabled(),
        yamahaReady:   yamaha.isReady(),
      });
      res.json(result);
    } catch (e) {
      logger.error('[notes] investigation error:', e.message);
      res.status(500).json({ error: 'Investigation failed. Check server logs.' });
    }
  });

  return router;
};
