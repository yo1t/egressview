'use strict';

// How much each application on an Agent's computer sent, by hour (P3-194).
//
// Counted as observations arrive rather than by scanning them later: adding
// one day's sent bytes from `agent_observations` took 1.1 to 1.4 s on the
// production Hub (2026-11-15, about 580,000 rows in 24 hours), too long to
// repeat for every look at the Agent tab. A flow's bytes arrive once -- with
// the observation, or with the closing report that completes it (P3-170) --
// and a repeated report is a duplicate that is not stored again, so adding at
// that moment counts each flow's bytes exactly once.
//
// Destinations are split into private and other addresses. On that Hub one
// Mac sent 167 GB in a day to a file share on its own LAN and 1.1 GB beyond
// it; one list of both would show the file share and nothing else. "Private"
// is the address range (LAN, loopback, CGNAT), not where the device is: a VPN
// or cloud address in those ranges counts as private too.
//
// Kept in tables created here rather than by a schema migration, for the
// reason agent-inbound-probes.js gives: a migration on this Hub begins with a
// verified copy of the whole database, minutes during which nothing is
// collected. The cost is that nothing before the tables existed is counted;
// `startedAt` says from when.

const { networkName } = require('./special-use-address');

// By hour, so "the last 24 hours" means that and not "since midnight UTC",
// which in Japan starts at 09:00. Measured 2026-11-15: about 230 applications
// across three Agents in a day, so a week is tens of thousands of rows.
const HOUR_MS = 60 * 60 * 1000;
// Applications listed per Agent; the totals cover the rest.
const LIST_MAX_APPS = 10;

function hourStartFor(at) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function isPrivateDestination(address) {
  return networkName(address) !== null;
}

function ensureAppBytesTables(db, { now = Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_app_bytes_hourly (
      hourStart INTEGER NOT NULL,
      agentId TEXT NOT NULL,
      appIdentity TEXT NOT NULL,
      privateDestination INTEGER NOT NULL CHECK(privateDestination IN (0, 1)),
      processName TEXT NOT NULL,
      flows INTEGER NOT NULL,
      flowsWithBytes INTEGER NOT NULL,
      bytesOut INTEGER NOT NULL,
      PRIMARY KEY (hourStart, agentId, appIdentity, privateDestination)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agent_app_bytes_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO agent_app_bytes_meta (key, value) VALUES ('startedAt', ?)").run(now);
}

/**
 * Returns a function that adds one flow, or its late byte count, to the hour
 * it ended in. Called inside the ingest transaction.
 *
 * `flows` is how many flows were seen, `flowsWithBytes` how many of them came
 * with a sent-bytes count. A flow whose count arrives with its closing report
 * is seen when it opens and counted when it closes, so the two can fall in
 * different hours.
 */
function createAppBytesRecorder(db) {
  const upsert = db.prepare(`
    INSERT INTO agent_app_bytes_hourly (
      hourStart, agentId, appIdentity, privateDestination, processName, flows, flowsWithBytes, bytesOut
    ) VALUES (
      @hourStart, @agentId, @appIdentity, @privateDestination, @processName, @flows, @flowsWithBytes, @bytesOut
    )
    ON CONFLICT (hourStart, agentId, appIdentity, privateDestination) DO UPDATE SET
      processName = excluded.processName,
      flows = agent_app_bytes_hourly.flows + excluded.flows,
      flowsWithBytes = agent_app_bytes_hourly.flowsWithBytes + excluded.flowsWithBytes,
      bytesOut = agent_app_bytes_hourly.bytesOut + excluded.bytesOut
  `);
  return function record({ agentId, appIdentity, processName, remoteAddress, at, newFlow, bytesOut }) {
    const counted = bytesOut != null;
    // Counts arrive as decimal strings up to 2^64; an hour's total stays far
    // below 2^53, and one absurd value must not poison the sum.
    const bytes = counted ? Number(bytesOut) : 0;
    if (!newFlow && !counted) return;
    upsert.run({
      hourStart: hourStartFor(at),
      agentId,
      appIdentity,
      privateDestination: isPrivateDestination(remoteAddress) ? 1 : 0,
      processName,
      flows: newFlow ? 1 : 0,
      flowsWithBytes: counted ? 1 : 0,
      bytesOut: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
    });
  };
}

/**
 * Per Agent, since `since` (rounded down to its hour): the applications that
 * sent most to addresses outside the private ranges, and the private-address
 * total with how much of it no application was named for.
 */
function listAppBytes(db, { since, limit = LIST_MAX_APPS } = {}) {
  const from = hourStartFor(since);
  const startedAt = db.prepare("SELECT value FROM agent_app_bytes_meta WHERE key = 'startedAt'").get()?.value ?? null;
  const totals = db.prepare(`
    SELECT agentId, privateDestination,
      SUM(flows) AS flows, SUM(flowsWithBytes) AS flowsWithBytes, SUM(bytesOut) AS bytesOut,
      SUM(CASE WHEN processName = 'unknown' THEN bytesOut ELSE 0 END) AS unnamedBytesOut
    FROM agent_app_bytes_hourly WHERE hourStart >= ?
    GROUP BY agentId, privateDestination
  `).all(from);
  const apps = db.prepare(`
    SELECT agentId, appIdentity, MAX(processName) AS processName,
      SUM(bytesOut) AS bytesOut, SUM(flows) AS flows
    FROM agent_app_bytes_hourly WHERE hourStart >= ? AND privateDestination = 0
    GROUP BY agentId, appIdentity
    HAVING SUM(bytesOut) > 0
    ORDER BY agentId, SUM(bytesOut) DESC
  `).all(from);

  const byAgent = new Map();
  const reportFor = agentId => {
    let report = byAgent.get(agentId);
    if (!report) {
      report = {
        agentId, flows: 0, flowsWithBytes: 0,
        beyond: { bytesOut: 0, apps: [], totalApps: 0 },
        private: { bytesOut: 0, unnamedBytesOut: 0 },
      };
      byAgent.set(agentId, report);
    }
    return report;
  };
  for (const row of totals) {
    const report = reportFor(row.agentId);
    report.flows += row.flows;
    report.flowsWithBytes += row.flowsWithBytes;
    if (row.privateDestination) {
      report.private.bytesOut = row.bytesOut;
      report.private.unnamedBytesOut = row.unnamedBytesOut;
    } else {
      report.beyond.bytesOut = row.bytesOut;
    }
  }
  for (const row of apps) {
    const report = reportFor(row.agentId);
    report.beyond.totalApps += 1;
    if (report.beyond.apps.length >= limit) continue;
    report.beyond.apps.push({
      appIdentity: row.appIdentity, processName: row.processName, bytesOut: row.bytesOut, flows: row.flows,
    });
  }
  return { startedAt, agents: [...byAgent.values()] };
}

function pruneAppBytes(db, before) {
  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_app_bytes_hourly'"
  ).get();
  if (!hasTable) return 0;
  return db.prepare('DELETE FROM agent_app_bytes_hourly WHERE hourStart < ?').run(hourStartFor(before)).changes;
}

module.exports = {
  LIST_MAX_APPS, HOUR_MS, hourStartFor, isPrivateDestination,
  ensureAppBytesTables, createAppBytesRecorder, listAppBytes, pruneAppBytes,
};
