// Routes: beacon detection results
'use strict';

const { Router } = require('express');
const { parsePositiveInt } = require('../utils');
const { t } = require('../i18n-server');

const MAX_WHITELIST_ENTRIES = 200;
const MAX_ORG_ENTRIES       = 100;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,62}\.)+[a-z]{2,}$/i;

/** Normalize a domain list from the request body; returns null on invalid input. */
function sanitizeDomainList(val) {
  if (!Array.isArray(val) || val.length > MAX_WHITELIST_ENTRIES) return null;
  const out = [];
  for (const raw of val) {
    if (typeof raw !== 'string') return null;
    const d = raw.trim().toLowerCase().replace(/^\*\./, '');  // accept "*.example.com" form
    if (!d) continue;
    if (d.length > 253 || !DOMAIN_RE.test(d)) return null;
    out.push(d);
  }
  return [...new Set(out)];
}

/** Normalize an org-substring list; returns null on invalid input. */
function sanitizeOrgList(val) {
  if (!Array.isArray(val) || val.length > MAX_ORG_ENTRIES) return null;
  const out = [];
  for (const raw of val) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) continue;
    if (s.length > 100) return null;
    out.push(s);
  }
  return [...new Set(out)];
}

/**
 * @param {{ requireAdmin, beacons, appState, saveConfig, onConfigChange }} ctx
 */
function beaconsRoutes(ctx) {
  const { requireAdmin, beacons, appState, saveConfig, onConfigChange } = ctx;
  const router = Router();

  // GET /api/beacons — return all beacon candidates (excluding dismissed)
  router.get('/beacons', requireAdmin, (req, res) => {
    const all = beacons.getBeacons();
    const includeDismissed = req.query.includeDismissed === '1';
    const results = includeDismissed ? all : all.filter(b => b.status !== 'dismissed');
    res.json({ beacons: results });
  });

  // GET /api/beacons/config — current detection settings
  router.get('/beacons/config', requireAdmin, (req, res) => {
    res.json({ config: appState.beaconConfig });
  });

  // POST /api/beacons/config — update detection settings, persist, rescan
  router.post('/beacons/config', requireAdmin, (req, res) => {
    const body = req.body || {};
    const cfg  = { ...appState.beaconConfig };

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: t('beacon.enabled-bool') });
      cfg.enabled = body.enabled;
    }
    if (body.minObs !== undefined) {
      const v = parsePositiveInt(body.minObs);
      if (v === null || v < 2) return res.status(400).json({ error: t('beacon.minObs-invalid') });
      cfg.minObs = v;
    }
    if (body.maxCov !== undefined) {
      const v = Number(body.maxCov);
      if (!Number.isFinite(v) || v <= 0 || v > 2) return res.status(400).json({ error: t('beacon.maxCov-invalid') });
      cfg.maxCov = v;
    }
    if (body.minIntervalMs !== undefined) {
      const v = parsePositiveInt(body.minIntervalMs);
      if (v === null) return res.status(400).json({ error: t('beacon.minInterval-invalid') });
      cfg.minIntervalMs = v;
    }
    if (body.maxIntervalMs !== undefined) {
      const v = parsePositiveInt(body.maxIntervalMs);
      if (v === null) return res.status(400).json({ error: t('beacon.maxInterval-invalid') });
      cfg.maxIntervalMs = v;
    }
    if (cfg.minIntervalMs >= cfg.maxIntervalMs) {
      return res.status(400).json({ error: t('beacon.interval-order') });
    }
    if (body.scanIntervalMs !== undefined) {
      const v = parsePositiveInt(body.scanIntervalMs);
      if (v === null || v < 5 * 60 * 1000) return res.status(400).json({ error: t('beacon.scanInterval-invalid') });
      cfg.scanIntervalMs = v;
    }
    if (body.whitelistDomains !== undefined) {
      const list = sanitizeDomainList(body.whitelistDomains);
      if (list === null) return res.status(400).json({ error: t('beacon.whitelist-invalid') });
      cfg.whitelistDomains = list;
    }
    if (body.orgAllowlist !== undefined) {
      const list = sanitizeOrgList(body.orgAllowlist);
      if (list === null) return res.status(400).json({ error: t('beacon.orglist-invalid') });
      cfg.orgAllowlist = list;
    }

    appState.beaconConfig = cfg;
    saveConfig();
    if (onConfigChange) onConfigChange();  // reschedule timer + immediate rescan
    res.json({ success: true, config: cfg });
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
