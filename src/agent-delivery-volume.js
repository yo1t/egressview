'use strict';

// How much each Agent sent to the Hub, and how many of its observations the
// Hub left out as older than it keeps, by hour.
//
// What it answers for the person looking at the Agent tab: how much of their
// network monitoring itself costs, and whether the Hub threw anything away
// from a computer that came back after a long time off. The Agents released
// since 2026-11-15 leave such observations out before sending, so the second
// number is normally zero; what an Agent left out itself never reaches the
// Hub and is not counted here.
//
// The size is the request body as it arrived (`Content-Length`), so it is
// what crossed the network, compressed or not. Every authenticated upload is
// counted, including ones the Hub refused or asked to be sent again: those
// were sent too. An upload without a declared size is counted as a request
// with no size, and the total says how many of those there were.
//
// Kept in tables created here rather than by a schema migration, for the
// reason agent-app-bytes.js gives: a migration on this Hub begins with a
// verified copy of the whole database. Nothing before the tables existed is
// counted; `startedAt` says from when.

const HOUR_MS = 60 * 60 * 1000;

function hourStartFor(at) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

function ensureDeliveryVolumeTables(db, { now = Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_delivery_hourly (
      hourStart INTEGER NOT NULL,
      agentId TEXT NOT NULL,
      requests INTEGER NOT NULL,
      requestsWithoutSize INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      expired INTEGER NOT NULL,
      PRIMARY KEY (hourStart, agentId)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS agent_delivery_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO agent_delivery_meta (key, value) VALUES ('startedAt', ?)").run(now);
}

// The declared body size, or null when there is none worth trusting.
function declaredSize(header) {
  if (typeof header !== 'string' || !/^\d{1,15}$/.test(header)) return null;
  return Number(header);
}

/** Adds one upload to the hour it arrived in. */
function recordDelivery(db, { agentId, at, contentLength, expired = 0 }) {
  const size = declaredSize(contentLength);
  db.prepare(`
    INSERT INTO agent_delivery_hourly (hourStart, agentId, requests, requestsWithoutSize, bytes, expired)
    VALUES (@hourStart, @agentId, 1, @withoutSize, @bytes, @expired)
    ON CONFLICT (hourStart, agentId) DO UPDATE SET
      requests = agent_delivery_hourly.requests + 1,
      requestsWithoutSize = agent_delivery_hourly.requestsWithoutSize + excluded.requestsWithoutSize,
      bytes = agent_delivery_hourly.bytes + excluded.bytes,
      expired = agent_delivery_hourly.expired + excluded.expired
  `).run({
    hourStart: hourStartFor(at),
    agentId,
    withoutSize: size === null ? 1 : 0,
    bytes: size ?? 0,
    expired: Number.isSafeInteger(expired) && expired > 0 ? expired : 0,
  });
}

/**
 * Per Agent, since `since` (rounded down to its hour): uploads, their total
 * size, and observations the Hub left out for age. `startedAt` is when the
 * Hub began counting.
 */
function listDeliveryVolume(db, { since }) {
  const startedAt = db.prepare("SELECT value FROM agent_delivery_meta WHERE key = 'startedAt'").get()?.value ?? null;
  const rows = db.prepare(`
    SELECT agentId, SUM(requests) AS requests, SUM(requestsWithoutSize) AS requestsWithoutSize,
      SUM(bytes) AS bytes, SUM(expired) AS expired
    FROM agent_delivery_hourly WHERE hourStart >= ?
    GROUP BY agentId
  `).all(hourStartFor(since));
  return { startedAt, agents: rows };
}

/** Removes hours older than `before`, as the observations are. */
function pruneDeliveryVolume(db, before) {
  return db.prepare('DELETE FROM agent_delivery_hourly WHERE hourStart < ?').run(hourStartFor(before)).changes;
}

module.exports = {
  HOUR_MS,
  ensureDeliveryVolumeTables,
  recordDelivery,
  listDeliveryVolume,
  pruneDeliveryVolume,
};
