// Routes: backup/restore/upload/config
'use strict';

const { Router } = require('express');
const { z } = require('zod');
const path = require('path');
const fs   = require('fs');
const { parseRequest } = require('../http-validation');
const logger = require('../logger');

const crypto = require('crypto');

const UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const backupNameSchema = z.object({ name: z.string().min(1).max(255) }).strict();
const backupConfigSchema = z.object({
  intervalHours: z.coerce.number().int().positive().optional(),
  maxGenerations: z.coerce.number().int().min(2).optional(),
  maxBackupBytes: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  autoPrune: z.boolean().optional(),
}).strict();
const backupPruneSchema = z.object({ execute: z.boolean().default(false) }).strict();
const backupPruneJobSchema = z.object({ jobId: z.string().uuid() }).strict();

/**
 * @param {{
 *   requireAdmin,
 *   backup, history,
 *   runtime,         // for setKnownMacs
 *   appRoot: string  // __dirname of server.js
 * }} ctx
 */
module.exports = function backupRoutes(ctx) {
  const {
    requireAdmin, backup, history, runtime, devices, enrichment, beacons,
    sessions, authAudit, apiIdentities, agentIdentities, agentIngest, io, appRoot,
  } = ctx;
  const router = Router();

  function closeDbConnections() {
    history.closeDb();
    sessions?.closeDb();
    devices.closeDb();
    enrichment.closeDb();
    beacons?.closeDb();
    authAudit?.closeDb();
    apiIdentities?.closeDb();
    agentIdentities?.closeDb();
    agentIngest?.closeDb();
  }

  function afterRestore() {
    history.loadConnectionHistory();
    runtime.setKnownMacs(history.getKnownMacs());
    devices.reopen();
    devices.seedFromConnectionHistory(history.getConnectionHistory());
    enrichment.reopen();
    if (beacons)  beacons.reopen();
    if (sessions) { sessions.reopen(); sessions.revokeAll(null); }
    authAudit?.reopen();
    apiIdentities?.reopen();
    agentIdentities?.reopen();
    agentIngest?.reopen();
    if (io) io.disconnectSockets(true);
  }

  router.get('/backup/list', requireAdmin, (req, res) => {
    try {
      res.json({
        backups: backup.listBackups(),
        config: backup.getConfig(),
        diagnostics: backup.inventory(),
        pruneJob: backup.getActivePruneJob?.() || null,
      });
    } catch (error) {
      logger.error('[backup] inventory error:', error.message);
      res.status(500).json({ error: 'Backup diagnostics failed. Check server logs.' });
    }
  });

  router.post('/backup/create', requireAdmin, async (req, res) => {
    try {
      const name = await backup.createBackup();
      if (name) res.json({ success: true, name });
      else res.status(500).json({ error: 'Backup failed' });
    } catch (e) {
      logger.error('[backup] create error:', e.message);
      res.status(500).json({ error: 'Backup failed. Check server logs.' });
    }
  });

  router.get('/backup/download/:name', requireAdmin, (req, res) => {
    const p = backup.getBackupPath(req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.download(p);
  });

  router.post('/backup/restore', requireAdmin, async (req, res) => {
    const parsed = parseRequest(backupNameSchema, req.body, res, { error: 'Backup name required' });
    if (!parsed.ok) return;
    const { name } = parsed.data;
    try {
      await backup.restoreFromGeneration(name, {
        beforeReplace: closeDbConnections,
        afterReplace: afterRestore,
        beforeRollback: closeDbConnections,
        afterRollback: afterRestore,
      });
      res.json({ success: true, message: `Restored from ${name}. Restart recommended.` });
    } catch (e) {
      logger.error('[backup] restore error:', e.message);
      res.status(500).json({ error: 'Restore failed. Check server logs.' });
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
      const tempPath = path.join(appRoot, `.egressview-upload-temp-${crypto.randomBytes(4).toString('hex')}.db`);
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 100) return res.status(400).json({ error: 'File too small' });
        if (!buf.slice(0, 16).equals(Buffer.from('SQLite format 3\0')))
          return res.status(400).json({ error: 'Invalid database file' });
        await fs.promises.writeFile(tempPath, buf);
        await backup.restoreFromFile(tempPath, {
          beforeReplace: closeDbConnections,
          afterReplace: afterRestore,
          beforeRollback: closeDbConnections,
          afterRollback: afterRestore,
        });
        res.json({ success: true, message: 'Restored from uploaded file. Restart recommended.' });
      } catch (e) {
        logger.error('[backup] upload restore error:', e.message);
        res.status(500).json({ error: 'Restore failed. Check server logs.' });
      } finally {
        await fs.promises.unlink(tempPath).catch(() => {});
      }
    });
  });

  router.post('/backup/config', requireAdmin, (req, res) => {
    const parsed = parseRequest(backupConfigSchema, req.body, res);
    if (!parsed.ok) return;
    const { intervalHours, maxGenerations, maxBackupBytes, autoPrune } = parsed.data;
    const previous = backup.getConfig();
    const updates = {};
    if (intervalHours != null) {
      updates.intervalHours = intervalHours;
    }
    if (maxGenerations != null) {
      updates.maxGenerations = maxGenerations;
    }
    if (maxBackupBytes != null) {
      updates.maxBackupBytes = maxBackupBytes;
    }
    if (autoPrune != null) {
      updates.autoPrune = autoPrune;
    }
    backup.configure(updates);
    backup.stopPeriodicBackup();
    backup.startPeriodicBackup();
    try {
      ctx.saveConfig();
    } catch (err) {
      backup.configure(previous);
      backup.stopPeriodicBackup();
      backup.startPeriodicBackup();
      logger.error('[backup] config save failed:', err.message);
      return res.status(500).json({ error: 'Backup settings were not saved. Check server logs.' });
    }
    res.json({ success: true, config: backup.getConfig() });
  });

  router.post('/backup/prune', requireAdmin, (req, res) => {
    const parsed = parseRequest(backupPruneSchema, req.body, res);
    if (!parsed.ok) return;
    try {
      const job = backup.startPruneJob({ execute: parsed.data.execute, source: 'manual' });
      res.status(202).json({ success: true, job });
    } catch (error) {
      if (error.code === 'BACKUP_PRUNE_BUSY') {
        return res.status(409).json({ error: 'A backup cleanup job is already running.', job: error.job });
      }
      logger.error('[backup] prune error:', error.message);
      res.status(500).json({ error: 'Backup cleanup failed safely. No unverified backup was removed.' });
    }
  });

  router.get('/backup/prune/:jobId', requireAdmin, (req, res) => {
    const parsed = parseRequest(backupPruneJobSchema, req.params, res);
    if (!parsed.ok) return;
    const job = backup.getPruneJob(parsed.data.jobId);
    if (!job) return res.status(404).json({ error: 'Backup cleanup job not found.' });
    res.json({ success: true, job });
  });

  router.delete('/backup/prune/:jobId', requireAdmin, (req, res) => {
    const parsed = parseRequest(backupPruneJobSchema, req.params, res);
    if (!parsed.ok) return;
    const job = backup.getPruneJob(parsed.data.jobId);
    if (!job) return res.status(404).json({ error: 'Backup cleanup job not found.' });
    if (job.status !== 'running') {
      return res.status(409).json({ error: 'Backup cleanup job is no longer running.', job });
    }
    backup.cancelPruneJob(parsed.data.jobId);
    res.json({ success: true, job: backup.getPruneJob(parsed.data.jobId) });
  });

  return router;
};
