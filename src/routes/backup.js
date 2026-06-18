// Routes: backup/restore/upload/config
'use strict';

const { Router } = require('express');
const path = require('path');
const fs   = require('fs');
const { parsePositiveInt } = require('../utils');

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
  const { requireAdmin, backup, history, runtime, devices, enrichment, beacons, sessions, appRoot } = ctx;
  const router = Router();

  router.get('/backup/list', requireAdmin, (req, res) => {
    res.json({ backups: backup.listBackups(), config: backup.getConfig() });
  });

  router.post('/backup/create', requireAdmin, async (req, res) => {
    const name = await backup.createBackup();
    if (name) res.json({ success: true, name });
    else res.status(500).json({ error: 'Backup failed' });
  });

  router.get('/backup/download/:name', requireAdmin, (req, res) => {
    const p = backup.getBackupPath(req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.download(p);
  });

  router.post('/backup/restore', requireAdmin, async (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Backup name required' });
    try {
      await backup.restoreFromGeneration(name);
      history.loadConnectionHistory();
      runtime.setKnownMacs(history.getKnownMacs());
      devices.reopen();                               // re-open DB connection to read restored data
      devices.seedFromConnectionHistory(history.getConnectionHistory()); // backfill devices from restored history
      enrichment.reopen();                            // RDAP/Geo キャッシュも restore 後の DB から再ロード
      if (beacons)  beacons.reopen();                 // beacon events / candidates も restore 後の DB から再ロード
      if (sessions) { sessions.reopen(); sessions.revokeAll(null); } // restore 後の DB に切り替え＋旧セッション破棄
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

    req.on('end', async () => {
      if (aborted) return;
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 100) return res.status(400).json({ error: 'File too small' });
        if (!buf.slice(0, 16).equals(Buffer.from('SQLite format 3\0')))
          return res.status(400).json({ error: 'Invalid database file' });
        const tempPath = path.join(appRoot, '.egressview-upload-temp.db');
        fs.writeFileSync(tempPath, buf);
        await backup.restoreFromFile(tempPath);
        fs.unlinkSync(tempPath);
        history.loadConnectionHistory();
        runtime.setKnownMacs(history.getKnownMacs());
        devices.reopen();                             // re-open DB connection to read restored data
        devices.seedFromConnectionHistory(history.getConnectionHistory()); // backfill devices from restored history
        enrichment.reopen();                          // RDAP/Geo キャッシュも restore 後の DB から再ロード
        if (beacons)  beacons.reopen();               // beacon events / candidates も restore 後の DB から再ロード
        if (sessions) sessions.reopen();              // ログインセッションも restore 後の DB に切り替え
        res.json({ success: true, message: 'Restored from uploaded file. Restart recommended.' });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  router.post('/backup/config', requireAdmin, (req, res) => {
    const { intervalHours, maxGenerations } = req.body || {};
    if (intervalHours != null) {
      const h = parsePositiveInt(intervalHours);
      if (h === null) return res.status(400).json({ error: 'intervalHours は 1 以上の整数で指定してください' });
      backup.configure({ intervalHours: h });
    }
    if (maxGenerations != null) {
      const g = parsePositiveInt(maxGenerations);
      if (g === null) return res.status(400).json({ error: 'maxGenerations は 1 以上の整数で指定してください' });
      backup.configure({ maxGenerations: g });
    }
    backup.stopPeriodicBackup();
    backup.startPeriodicBackup();
    ctx.saveConfig();
    res.json({ success: true, config: backup.getConfig() });
  });

  return router;
};
