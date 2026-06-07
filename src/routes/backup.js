// Routes: backup/restore/upload/config
'use strict';

const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * @param {{
 *   requireAdmin,
 *   backup, history,
 *   runtime,         // for setKnownMacs
 *   appRoot: string  // __dirname of server.js
 * }} ctx
 */
module.exports = function backupRoutes(ctx) {
  const { requireAdmin, backup, history, runtime, devices, appRoot } = ctx;
  const router = Router();

  router.get('/backup/list', requireAdmin, (req, res) => {
    res.json({ backups: backup.listBackups(), config: backup.getConfig() });
  });

  router.post('/backup/create', requireAdmin, (req, res) => {
    const name = backup.createBackup();
    if (name) res.json({ success: true, name });
    else res.status(500).json({ error: 'Backup failed' });
  });

  router.get('/backup/download/:name', requireAdmin, (req, res) => {
    const p = backup.getBackupPath(req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.download(p);
  });

  router.post('/backup/restore', requireAdmin, (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Backup name required' });
    try {
      backup.restoreFromGeneration(name);
      history.loadConnectionHistory();
      runtime.setKnownMacs(history.getKnownMacs());
      devices.reopen();                               // re-open DB connection to read restored data
      devices.seedFromConnectionHistory(history.getConnectionHistory()); // backfill devices from restored history
      res.json({ success: true, message: `Restored from ${name}. Restart recommended.` });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/backup/upload', requireAdmin, (req, res) => {
    const chunks  = [];
    let received  = 0;
    let aborted   = false;

    req.on('data', chunk => {
      if (aborted) return;
      received += chunk.length;
      if (received > UPLOAD_MAX_BYTES) {
        aborted = true;
        res.status(413).json({ error: `File too large (max ${UPLOAD_MAX_BYTES / 1024 / 1024}MB)` });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 100) return res.status(400).json({ error: 'File too small' });
        const tempPath = path.join(appRoot, '.widemap-upload-temp.db');
        fs.writeFileSync(tempPath, buf);
        backup.restoreFromFile(tempPath);
        fs.unlinkSync(tempPath);
        history.loadConnectionHistory();
        runtime.setKnownMacs(history.getKnownMacs());
        devices.reopen();                             // re-open DB connection to read restored data
        devices.seedFromConnectionHistory(history.getConnectionHistory()); // backfill devices from restored history
        res.json({ success: true, message: 'Restored from uploaded file. Restart recommended.' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  router.post('/backup/config', requireAdmin, (req, res) => {
    const { intervalHours, maxGenerations } = req.body || {};
    if (intervalHours)  backup.configure({ intervalHours: Number(intervalHours) });
    if (maxGenerations) backup.configure({ maxGenerations: Number(maxGenerations) });
    backup.stopPeriodicBackup();
    backup.startPeriodicBackup();
    ctx.saveConfig();
    res.json({ success: true, config: backup.getConfig() });
  });

  return router;
};
