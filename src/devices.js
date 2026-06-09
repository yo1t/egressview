// Device inventory: aggregates IP/MAC/name/vendor data from all sources into a single table.
// Sources: connection history (NAT/INSPECT), DHCP events, ARP/NDP, mDNS, investigation results.
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');

// Merge candidate thresholds
const CANDIDATE_SCORE = 0.4;  // save for manual review
// AUTO_MERGE_SCORE = 0.8 — reserved, not enabled (too risky without user confirmation)

// Minimum interval between observations for the same (deviceId, source).
// Prevents count explosion when a source emits conflicting data on consecutive polls.
// Set to 0 in tests to allow back-to-back observations.
let OBS_MIN_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let db        = null;
let _dbPath   = DB_PATH;
let stmtUpsert            = null;
let stmtSelectAll         = null;
let stmtSelectIp          = null;
let stmtSelectMac         = null;
let stmtSelectDeviceId    = null;
let stmtLastObservation   = null;
let stmtInsertObservation = null;
let stmtByMdns            = null;
let stmtByDns             = null;
let stmtUpsertCandidate   = null;

// ─── isStableMac ──────────────────────────────────────────────────────────────

/**
 * Returns true if mac is a globally unique (OUI-assigned) hardware MAC.
 * Returns false for privacy/locally-administered MACs, broadcast, all-zero, or invalid input.
 */
function isStableMac(mac) {
  if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac)) return false;
  if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') return false;
  const first = parseInt(mac.split(':')[0], 16);
  return (first & 0x02) === 0;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initDb(dbPath) {
  _dbPath = dbPath || DB_PATH;
  db = new Database(_dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // ── Core devices table ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      ip          TEXT PRIMARY KEY,
      mac         TEXT,
      vendor      TEXT,
      dnsName     TEXT,
      mdnsName    TEXT,
      netbiosName TEXT,
      ipv6Addr    TEXT,
      firstSeen   INTEGER NOT NULL,
      lastSeen    INTEGER NOT NULL,
      sources     TEXT NOT NULL DEFAULT '',
      noteKey     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_devices_mac      ON devices(mac);
    CREATE INDEX IF NOT EXISTS idx_devices_lastSeen ON devices(lastSeen);
  `);

  // Step 1a: deviceId column migration + backfill ────────────────────────────
  const cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name);
  if (!cols.includes('deviceId')) {
    db.exec('ALTER TABLE devices ADD COLUMN deviceId TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_deviceId ON devices(deviceId)');

  // P1-8: soft-delete columns ─────────────────────────────────────────────────
  // archivedAt: set on merge/manual archive; archivedAt IS NULL = active device
  // mergedInto: deviceId of the surviving device after a merge
  if (!cols.includes('archivedAt')) {
    db.exec('ALTER TABLE devices ADD COLUMN archivedAt INTEGER DEFAULT NULL');
  }
  if (!cols.includes('mergedInto')) {
    db.exec('ALTER TABLE devices ADD COLUMN mergedInto TEXT DEFAULT NULL');
  }

  const _backfill = db.transaction(() => {
    const rows = db.prepare('SELECT ip FROM devices WHERE deviceId IS NULL').all();
    const fill = db.prepare('UPDATE devices SET deviceId = ? WHERE ip = ?');
    for (const row of rows) fill.run(crypto.randomUUID(), row.ip);
  });
  _backfill();

  // Step 2: device_observations table ─────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceId    TEXT    NOT NULL,
      observedAt  INTEGER NOT NULL,
      source      TEXT    NOT NULL,
      ip          TEXT,
      mac         TEXT,
      ipv6        TEXT,
      hostname    TEXT,
      mdnsName    TEXT,
      netbiosName TEXT,
      asusName    TEXT,
      vendor      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_obs_deviceId
      ON device_observations(deviceId, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_obs_source
      ON device_observations(source, observedAt DESC);
  `);

  // Step 6: device_merge_candidates table ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_merge_candidates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      deviceIdA  TEXT    NOT NULL,
      deviceIdB  TEXT    NOT NULL,
      score      REAL    NOT NULL,
      reasons    TEXT    NOT NULL DEFAULT '[]',
      status     TEXT    NOT NULL DEFAULT 'pending',
      createdAt  INTEGER NOT NULL,
      resolvedAt INTEGER,
      UNIQUE(deviceIdA, deviceIdB)
    );
    CREATE INDEX IF NOT EXISTS idx_merge_status
      ON device_merge_candidates(status, createdAt DESC);
  `);

  // ── Prepared statements ──────────────────────────────────────────────────────

  stmtUpsert = db.prepare(`
    INSERT INTO devices
      (ip, mac, vendor, dnsName, mdnsName, netbiosName, ipv6Addr,
       firstSeen, lastSeen, sources, noteKey, deviceId)
    VALUES
      (@ip, @mac, @vendor, @dnsName, @mdnsName, @netbiosName, @ipv6Addr,
       @firstSeen, @lastSeen, @sources, @noteKey, @deviceId)
    ON CONFLICT(ip) DO UPDATE SET
      mac         = COALESCE(@mac,         mac),
      vendor      = COALESCE(@vendor,      vendor),
      dnsName     = COALESCE(@dnsName,     dnsName),
      mdnsName    = COALESCE(@mdnsName,    mdnsName),
      netbiosName = COALESCE(@netbiosName, netbiosName),
      ipv6Addr    = COALESCE(@ipv6Addr,    ipv6Addr),
      firstSeen   = MIN(firstSeen, @firstSeen),
      lastSeen    = MAX(lastSeen,  @lastSeen),
      sources     = CASE
        WHEN instr(sources, @newSource) > 0 THEN sources
        WHEN sources = ''                   THEN @newSource
        ELSE sources || ',' || @newSource
      END,
      noteKey     = COALESCE(@noteKey,     noteKey),
      deviceId    = COALESCE(deviceId,     excluded.deviceId),
      archivedAt  = devices.archivedAt    -- NEVER overwrite: preserve archived/merged status
    RETURNING deviceId
  `);

  stmtSelectAll      = db.prepare('SELECT * FROM devices WHERE archivedAt IS NULL ORDER BY lastSeen DESC');
  stmtSelectIp       = db.prepare('SELECT * FROM devices WHERE ip = ?');           // includes archived (needed for merge detection)
  stmtSelectMac      = db.prepare('SELECT * FROM devices WHERE mac = ? AND archivedAt IS NULL');
  stmtSelectDeviceId = db.prepare('SELECT * FROM devices WHERE deviceId = ?');     // includes archived (needed for approveMerge)

  stmtLastObservation = db.prepare(`
    SELECT ip, mac, ipv6, hostname, mdnsName, netbiosName, asusName, vendor
    FROM   device_observations
    WHERE  deviceId = ? AND source = ?
    ORDER  BY observedAt DESC
    LIMIT  1
  `);

  stmtInsertObservation = db.prepare(`
    INSERT INTO device_observations
      (deviceId, observedAt, source, ip, mac, ipv6, hostname, mdnsName, netbiosName, asusName, vendor)
    VALUES
      (@deviceId, @observedAt, @source,
       @ip, @mac, @ipv6, @hostname, @mdnsName, @netbiosName, @asusName, @vendor)
  `);

  stmtByMdns = db.prepare(
    'SELECT * FROM devices WHERE mdnsName = ? AND deviceId != ? AND archivedAt IS NULL COLLATE NOCASE'
  );
  stmtByDns = db.prepare(
    'SELECT * FROM devices WHERE dnsName  = ? AND deviceId != ? AND archivedAt IS NULL COLLATE NOCASE'
  );
  stmtUpsertCandidate = db.prepare(`
    INSERT INTO device_merge_candidates
      (deviceIdA, deviceIdB, score, reasons, status, createdAt)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(deviceIdA, deviceIdB) DO UPDATE SET
      score   = MAX(score,   excluded.score),
      reasons = excluded.reasons
    WHERE status = 'pending'
  `);
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Upsert a device into the summary devices table.
 * Returns the canonical deviceId for this device.
 */
function upsert(d) {
  if (!db) return null;
  const now = Date.now();
  const row = stmtUpsert.get({
    ip:          d.ip,
    mac:         d.mac         || null,
    vendor:      d.vendor      || null,
    dnsName:     d.dnsName     || null,
    mdnsName:    d.mdnsName    || null,
    netbiosName: d.netbiosName || null,
    ipv6Addr:    d.ipv6Addr    || null,
    firstSeen:   d.firstSeen   ?? now,
    lastSeen:    d.lastSeen    ?? now,
    sources:     d.source      || '',
    newSource:   d.source      || '',
    noteKey:     d.noteKey     || null,
    deviceId:    d.deviceId    || crypto.randomUUID(),
  });
  return row?.deviceId || null;
}

// ─── observeDevice ────────────────────────────────────────────────────────────

/**
 * Higher-level device tracking. In addition to upsert():
 *   1. stable-MAC auto-linking: if IP is new but MAC is globally unique and matches
 *      exactly one known device, reuse its deviceId and migrate the row's IP.
 *   2. write-on-change: writes device_observations only when attributes change.
 *   3. merge candidate detection: when a name-bearing device changes, checks for
 *      other devices with matching mdnsName/dnsName and saves merge candidates.
 *
 * @returns {string|null} deviceId
 */
function observeDevice(d) {
  if (!db) return null;
  const now = Date.now();

  // ── 1. Look up by IP ──────────────────────────────────────────────────────
  let existingDevice = d.ip ? stmtSelectIp.get(d.ip) : null;

  // ── 1a. Archived IP guard / mergedInto redirect ──────────────────────────
  // If the IP row is archived (merged away), redirect the observation to the
  // surviving device (mergedInto) so its lastSeen and attributes stay current
  // even when the old IP resurfaces (e.g. DHCP re-assign).
  // Manual-archive rows (mergedInto = null) are silently dropped as before.
  if (existingDevice && existingDevice.archivedAt != null) {
    if (existingDevice.mergedInto) {
      const keepDevice = stmtSelectDeviceId.get(existingDevice.mergedInto);
      if (keepDevice && keepDevice.archivedAt == null && keepDevice.ip) {
        // Redirect: treat this observation as if it arrived for the keep device.
        existingDevice = keepDevice;
        d = { ...d, ip: keepDevice.ip };
        // fall through to normal upsert / observation logic
      } else {
        return null; // keep is itself archived or has no IP — drop
      }
    } else {
      return null; // no merge target (manual archive) — silently drop
    }
  }

  // ── 2. Stable-MAC auto-link ───────────────────────────────────────────────
  if (!existingDevice && d.mac && isStableMac(d.mac)) {
    const byMac = stmtSelectMac.all(d.mac);
    if (byMac.length === 1 && d.ip) {
      const candidate = byMac[0];
      const newIpTaken = stmtSelectIp.get(d.ip);
      if (!newIpTaken) {
        db.prepare('UPDATE devices SET ip = ?, lastSeen = ? WHERE deviceId = ?')
          .run(d.ip, now, candidate.deviceId);
        existingDevice = { ...candidate, ip: d.ip };
      }
    }
  }

  // ── 3. Upsert summary table ───────────────────────────────────────────────
  const deviceId = upsert({
    ip:          d.ip,
    mac:         d.mac         || null,
    vendor:      d.vendor      || null,
    dnsName:     d.dnsName     || null,
    mdnsName:    d.mdnsName    || null,
    netbiosName: d.netbiosName || null,
    ipv6Addr:    d.ipv6Addr    || d.ipv6 || null,
    firstSeen:   d.firstSeen   ?? now,
    lastSeen:    d.lastSeen    ?? now,
    source:      d.source,
    noteKey:     d.noteKey     || null,
    deviceId:    existingDevice?.deviceId,
  });

  // ── 4. Write observation (write-on-change) ────────────────────────────────
  const attrs = {
    ip:          d.ip          || null,
    mac:         d.mac         || null,
    ipv6:        d.ipv6        || d.ipv6Addr || null,
    hostname:    d.dnsName     || null,
    mdnsName:    d.mdnsName    || null,
    netbiosName: d.netbiosName || null,
    asusName:    d.asusName    || null,
    vendor:      d.vendor      || null,
  };

  const changed = deviceId && _hasObservationChanged(deviceId, d.source || 'nat', attrs);
  if (changed) {
    stmtInsertObservation.run({
      deviceId,
      observedAt: now,
      source:     d.source || 'nat',
      ...attrs,
    });

    // ── 5. Merge candidate check ─────────────────────────────────────────
    // Only when name data is present — these are the scoring signals
    if (d.mdnsName || d.dnsName) {
      checkMergeCandidates(deviceId);
    }
  }

  return deviceId;
}

function _hasObservationChanged(deviceId, source, attrs) {
  const last = stmtLastObservation.get(deviceId, source);
  if (!last) return true;
  // Safety net: suppress writes within the minimum interval even if attrs differ.
  // This prevents observation explosions when a source emits conflicting data rapidly.
  if (OBS_MIN_INTERVAL_MS > 0 && (Date.now() - last.observedAt) < OBS_MIN_INTERVAL_MS) return false;
  const keys = ['ip', 'mac', 'ipv6', 'hostname', 'mdnsName', 'netbiosName', 'asusName', 'vendor'];
  return keys.some(k => (attrs[k] || null) !== (last[k] || null));
}

// ─── Merge scoring (step 5) ──────────────────────────────────────────────────

/**
 * Compute a similarity score between two device rows.
 * Considers soft evidence (names, vendor) — not MAC (handled by isStableMac auto-link).
 *
 * @param {object} a
 * @param {object} b
 * @returns {{ score: number, reasons: string[] }}  score is 0-1
 */
function computeMergeScore(a, b) {
  if (!a || !b || a.deviceId === b.deviceId) return { score: 0, reasons: [] };

  let score = 0;
  const reasons = [];

  // mDNS name (strong: device-announced, usually globally unique hostname like "Johns-iPhone.local")
  if (a.mdnsName && b.mdnsName &&
      a.mdnsName.toLowerCase() === b.mdnsName.toLowerCase()) {
    score += 0.5;
    reasons.push(`mdnsName="${a.mdnsName}"`);
  }

  // DNS/hostname (medium: assigned by DHCP or reverse-DNS, may not be unique)
  if (a.dnsName && b.dnsName &&
      a.dnsName.toLowerCase() === b.dnsName.toLowerCase()) {
    score += 0.3;
    reasons.push(`dnsName="${a.dnsName}"`);
  }

  // Vendor (weak: many devices share a vendor string)
  if (a.vendor && b.vendor && a.vendor === b.vendor) {
    score += 0.15;
    reasons.push(`vendor="${a.vendor}"`);
  }

  return { score: Math.min(score, 1), reasons };
}

// ─── Merge candidate detection (step 6) ──────────────────────────────────────

/**
 * After a device's name data changes, search for other devices that share the
 * same mdnsName or dnsName and save as merge candidates if score >= CANDIDATE_SCORE.
 */
function checkMergeCandidates(deviceId) {
  if (!db) return;
  const device = stmtSelectDeviceId.get(deviceId);
  if (!device) return;

  // Collect matching devices (deduplicated)
  const seen  = new Set();
  const peers = [];

  const addPeers = (rows) => {
    for (const r of rows) {
      if (!seen.has(r.deviceId)) { seen.add(r.deviceId); peers.push(r); }
    }
  };

  if (device.mdnsName) addPeers(stmtByMdns.all(device.mdnsName, deviceId));
  if (device.dnsName)  addPeers(stmtByDns.all(device.dnsName,  deviceId));

  for (const other of peers) {
    const { score, reasons } = computeMergeScore(device, other);
    if (score < CANDIDATE_SCORE) continue;

    // Canonical ordering: smaller deviceId first (prevents (A,B) vs (B,A) duplicates)
    const [idA, idB] = device.deviceId < other.deviceId
      ? [device.deviceId, other.deviceId]
      : [other.deviceId, device.deviceId];

    stmtUpsertCandidate.run(idA, idB, score, JSON.stringify(reasons), Date.now());
  }
}

/**
 * Return merge candidates, joined with both device rows for context.
 * @param {'pending'|'approved'|'rejected'|'all'} status
 */
function getMergeCandidates(status = 'pending') {
  if (!db) return [];
  const where = status === 'all' ? '' : 'WHERE c.status = ?';
  const args  = status === 'all' ? []  : [status];
  return db.prepare(`
    SELECT
      c.id, c.deviceIdA, c.deviceIdB, c.score, c.reasons, c.status,
      c.createdAt, c.resolvedAt,
      a.ip as ipA, a.mac as macA, a.vendor as vendorA,
      a.mdnsName as mdnsNameA, a.dnsName as dnsNameA,
      b.ip as ipB, b.mac as macB, b.vendor as vendorB,
      b.mdnsName as mdnsNameB, b.dnsName as dnsNameB
    FROM device_merge_candidates c
    LEFT JOIN devices a ON a.deviceId = c.deviceIdA
    LEFT JOIN devices b ON b.deviceId = c.deviceIdB
    ${where}
    ORDER BY c.score DESC, c.createdAt DESC
  `).all(...args);
}

/**
 * Approve a merge: fold dropId into keepId, reassign observations, delete dropId.
 * @returns {boolean}
 */
function approveMerge(keepId, dropId) {
  if (!db) return false;
  const keep = stmtSelectDeviceId.get(keepId);
  const drop = stmtSelectDeviceId.get(dropId);
  if (!keep || !drop) return false;

  db.transaction(() => {
    // 1. Reassign all observations from drop → keep
    db.prepare('UPDATE device_observations SET deviceId = ? WHERE deviceId = ?')
      .run(keepId, dropId);

    // 2. Fill any null fields in keep from drop
    db.prepare(`
      UPDATE devices SET
        mac         = COALESCE(mac,         ?),
        vendor      = COALESCE(vendor,      ?),
        dnsName     = COALESCE(dnsName,     ?),
        mdnsName    = COALESCE(mdnsName,    ?),
        netbiosName = COALESCE(netbiosName, ?),
        ipv6Addr    = COALESCE(ipv6Addr,    ?),
        firstSeen   = MIN(firstSeen,        ?)
      WHERE deviceId = ?
    `).run(drop.mac, drop.vendor, drop.dnsName, drop.mdnsName,
           drop.netbiosName, drop.ipv6Addr, drop.firstSeen, keepId);

    // 3. Soft-delete the dropped device (archive instead of DELETE)
    //    archivedAt IS NOT NULL → excluded from getAll / observeDevice / stmtSelectMac
    //    mergedInto  tracks which device absorbed it (for audit/future unarchive)
    db.prepare('UPDATE devices SET archivedAt = ?, mergedInto = ? WHERE deviceId = ?')
      .run(Date.now(), keepId, dropId);

    // 4. Mark all pending candidates involving either device as approved
    db.prepare(`
      UPDATE device_merge_candidates
      SET status = 'approved', resolvedAt = ?
      WHERE (deviceIdA IN (?,?) OR deviceIdB IN (?,?)) AND status = 'pending'
    `).run(Date.now(), keepId, dropId, keepId, dropId);
  })();

  return true;
}

/**
 * Reject a merge candidate by id.
 */
function rejectCandidate(candidateId) {
  if (!db) return false;
  db.prepare(`
    UPDATE device_merge_candidates SET status = 'rejected', resolvedAt = ? WHERE id = ?
  `).run(Date.now(), candidateId);
  return true;
}

// ─── Status ───────────────────────────────────────────────────────────────────

/**
 * Compute display status from lastSeen timestamp.
 * 'active'  : seen within 24 h
 * 'recent'  : seen within 7 days
 * 'stale'   : not seen for 7+ days
 */
function deviceStatus(lastSeen) {
  const age = Date.now() - (lastSeen || 0);
  if (age < 24 * 60 * 60 * 1000)      return 'active';
  if (age < 7  * 24 * 60 * 60 * 1000) return 'recent';
  return 'stale';
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Return all devices with a computed `status` field.
 * @param {{ includeArchived?: boolean }} [opts]
 */
function getAll({ includeArchived = false } = {}) {
  if (!db) return [];
  const rows = includeArchived
    ? db.prepare('SELECT * FROM devices ORDER BY lastSeen DESC').all()
    : stmtSelectAll.all();
  return rows.map(d => ({
    ...d,
    status: d.archivedAt != null ? 'archived' : deviceStatus(d.lastSeen),
  }));
}

/**
 * Manually archive a device (soft-delete without merge).
 * @returns {boolean}
 */
function archiveDevice(deviceId) {
  if (!db) return false;
  const r = db.prepare(
    'UPDATE devices SET archivedAt = ? WHERE deviceId = ? AND archivedAt IS NULL'
  ).run(Date.now(), deviceId);
  return r.changes > 0;
}

/**
 * Restore an archived device back to active tracking.
 * Clears archivedAt and mergedInto so the device becomes visible again.
 * @returns {boolean}
 */
function unarchiveDevice(deviceId) {
  if (!db) return false;
  const r = db.prepare(
    'UPDATE devices SET archivedAt = NULL, mergedInto = NULL WHERE deviceId = ?'
  ).run(deviceId);
  return r.changes > 0;
}

function getByIp(ip) {
  if (!db) return null;
  const row = stmtSelectIp.get(ip);
  return (row && row.archivedAt == null) ? row : null;
}

function getByMac(mac) {
  if (!db) return [];
  return stmtSelectMac.all(mac);
}

function getByDeviceId(deviceId) {
  if (!db) return null;
  return stmtSelectDeviceId.get(deviceId) || null;
}

// ─── Startup: stale merge-candidate batch ─────────────────────────────────

/**
 * Run checkMergeCandidates() for every non-archived stale device (lastSeen older than 7 days).
 * Called once at startup so devices that haven't been observed recently still
 * get their duplicate candidates surfaced for manual review.
 * @returns {number} number of stale devices scanned
 */
function checkStaleMergeCandidates() {
  if (!db) return 0;
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - STALE_MS;
  const staleDevices = db.prepare(
    'SELECT deviceId FROM devices WHERE archivedAt IS NULL AND lastSeen < ?'
  ).all(cutoff);
  for (const { deviceId } of staleDevices) {
    checkMergeCandidates(deviceId);
  }
  return staleDevices.length;
}

// ─── Populate from existing connection history ─────────────────────────────

function seedFromConnectionHistory(connectionHistory) {
  if (!db) return;
  const seed = db.transaction(() => {
    for (const entry of connectionHistory.values()) {
      if (!entry.src) continue;
      upsert({
        ip:        entry.src,
        mac:       entry.srcMac      || null,
        vendor:    entry.srcVendor   || null,
        dnsName:   entry.srcDnsName  || null,
        mdnsName:  entry.srcMdnsName || null,
        firstSeen: entry.firstSeen,
        lastSeen:  entry.lastSeen,
        source:    'nat',
      });
    }
  });
  seed();
}

// ─── Reopen ───────────────────────────────────────────────────────────────────

function reopen() {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(_dbPath);
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function _initForTest() {
  if (db) { try { db.close(); } catch {} db = null; }
  OBS_MIN_INTERVAL_MS = 0;   // disable cooldown so back-to-back test observations work
  initDb(':memory:');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  reopen,
  upsert,
  observeDevice,
  deviceStatus,
  getAll,
  getByIp,
  getByMac,
  getByDeviceId,
  archiveDevice,
  unarchiveDevice,
  isStableMac,
  computeMergeScore,
  getMergeCandidates,
  approveMerge,
  rejectCandidate,
  seedFromConnectionHistory,
  checkStaleMergeCandidates,
  _initForTest,
};
