// Device inventory: aggregates IP/MAC/name/vendor data from all sources into a single table.
// Sources: connection history (NAT/INSPECT), DHCP events, ARP/NDP, mDNS, investigation results.
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '.widemap.db');

let db = null;
let stmtUpsert   = null;
let stmtSelectAll = null;
let stmtSelectIp  = null;
let stmtSelectMac = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function initDb(dbPath) {
  // Re-use connection history DB (same file), or use provided path for tests
  db = new Database(dbPath || DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      ip         TEXT PRIMARY KEY,
      mac        TEXT,
      vendor     TEXT,
      dnsName    TEXT,
      mdnsName   TEXT,
      netbiosName TEXT,
      ipv6Addr   TEXT,
      firstSeen  INTEGER NOT NULL,
      lastSeen   INTEGER NOT NULL,
      sources    TEXT NOT NULL DEFAULT '',
      noteKey    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_devices_mac ON devices(mac);
    CREATE INDEX IF NOT EXISTS idx_devices_lastSeen ON devices(lastSeen);
  `);

  stmtUpsert = db.prepare(`
    INSERT INTO devices (ip, mac, vendor, dnsName, mdnsName, netbiosName, ipv6Addr, firstSeen, lastSeen, sources, noteKey)
    VALUES (@ip, @mac, @vendor, @dnsName, @mdnsName, @netbiosName, @ipv6Addr, @firstSeen, @lastSeen, @sources, @noteKey)
    ON CONFLICT(ip) DO UPDATE SET
      mac         = COALESCE(@mac, mac),
      vendor      = COALESCE(@vendor, vendor),
      dnsName     = COALESCE(@dnsName, dnsName),
      mdnsName    = COALESCE(@mdnsName, mdnsName),
      netbiosName = COALESCE(@netbiosName, netbiosName),
      ipv6Addr    = COALESCE(@ipv6Addr, ipv6Addr),
      firstSeen   = MIN(firstSeen, @firstSeen),
      lastSeen    = MAX(lastSeen, @lastSeen),
      sources     = CASE
        WHEN instr(sources, @newSource) > 0 THEN sources
        WHEN sources = ''                   THEN @newSource
        ELSE sources || ',' || @newSource
      END,
      noteKey     = COALESCE(@noteKey, noteKey)
  `);

  stmtSelectAll = db.prepare('SELECT * FROM devices ORDER BY lastSeen DESC');
  stmtSelectIp  = db.prepare('SELECT * FROM devices WHERE ip = ?');
  stmtSelectMac = db.prepare('SELECT * FROM devices WHERE mac = ?');
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Upsert a device observation.
 * @param {object} d
 * @param {string} d.ip          Required
 * @param {string} [d.mac]
 * @param {string} [d.vendor]
 * @param {string} [d.dnsName]
 * @param {string} [d.mdnsName]
 * @param {string} [d.netbiosName]
 * @param {string} [d.ipv6Addr]
 * @param {number} [d.firstSeen]
 * @param {number} [d.lastSeen]
 * @param {string} [d.source]    Short tag, e.g. 'nat', 'dhcp', 'inspect', 'arp', 'mdns'
 * @param {string} [d.noteKey]
 */
function upsert(d) {
  if (!db) return;
  const now = Date.now();
  stmtUpsert.run({
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
  });
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** @returns {Array} all devices, newest-last-seen first */
function getAll() {
  if (!db) return [];
  return stmtSelectAll.all();
}

/** @returns {object|null} */
function getByIp(ip) {
  if (!db) return null;
  return stmtSelectIp.get(ip) || null;
}

/** @returns {Array} */
function getByMac(mac) {
  if (!db) return [];
  return stmtSelectMac.all(mac);
}

// ─── Populate from existing connection history ─────────────────────────────

/**
 * Seed devices table from connection history at startup.
 * Runs once; rows already present are updated (UPSERT is idempotent).
 */
function seedFromConnectionHistory(connectionHistory) {
  if (!db) return;
  const seed = db.transaction(() => {
    for (const entry of connectionHistory.values()) {
      if (!entry.src) continue;
      upsert({
        ip:        entry.src,
        mac:       entry.srcMac     || null,
        vendor:    entry.srcVendor  || null,
        dnsName:   entry.srcDnsName || null,
        mdnsName:  entry.srcMdnsName || null,
        firstSeen: entry.firstSeen,
        lastSeen:  entry.lastSeen,
        source:    'nat',
      });
    }
  });
  seed();
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function _initForTest() {
  if (db) { try { db.close(); } catch {} db = null; }
  initDb(':memory:');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  upsert,
  getAll,
  getByIp,
  getByMac,
  seedFromConnectionHistory,
  _initForTest,
};
