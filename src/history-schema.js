'use strict';

/**
 * The tables a database is given directly, rather than by a migration.
 *
 * Split out of `history.js` (P2-97): it was 150 of that file's 856 lines, and
 * it is what you open when you add a column -- not something to scroll past
 * while reading how the database is opened and recovered.
 *
 * **Most of it does nothing.** `initDb` runs migrations first, and on an empty
 * database those build the schema from version 0 to the current one. Measured
 * 2026-08-29: migrations create 42 objects, and re-running everything below
 * then creates **6** -- `connections`, `notification_log`, and four indexes.
 * Those predate migrations, which is why nothing creates them.
 *
 * Every statement is `IF NOT EXISTS`, so the other 36 definitions are ignored
 * wherever they disagree with what the migrations built. **A column added to
 * one of them takes effect nowhere**, on a fresh database or an existing one.
 * `test/unit/history-schema.test.js` pins which six are real so that
 * duplication cannot quietly grow.
 */

/** Connection rows and the indexes reads depend on. */
const CONNECTIONS_SQL = `
    CREATE TABLE IF NOT EXISTS connections (
      src       TEXT NOT NULL,
      dst       TEXT NOT NULL,
      dport     INTEGER NOT NULL,
      proto     TEXT NOT NULL,
      sport     INTEGER,
      ttl       INTEGER,
      srcMac    TEXT,
      srcVendor TEXT,
      srcDnsName  TEXT,
      srcMdnsName TEXT,
      dstHost   TEXT,
      country   TEXT,
      org       TEXT,
      lat       REAL,
      lon       REAL,
      city      TEXT,
      firstSeen INTEGER NOT NULL,
      lastSeen  INTEGER NOT NULL,
      agentHost TEXT,
      process   TEXT,
      pid       INTEGER,
      PRIMARY KEY (src, dst, dport, proto)
    );
    CREATE INDEX IF NOT EXISTS idx_lastSeen ON connections(lastSeen);
    CREATE INDEX IF NOT EXISTS idx_src ON connections(src);
    CREATE INDEX IF NOT EXISTS idx_dst ON connections(dst);
`;

/**
 * Multi-router observation tables.
 *
 * Normally created by the v4 migration; repeated here so a fresh DB gets them
 * too.
 */
const OBSERVATIONS_SQL = `
    CREATE TABLE IF NOT EXISTS routers (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      displayName TEXT NOT NULL,
      createdAt   INTEGER NOT NULL,
      deletedAt   INTEGER
    );
    CREATE TABLE IF NOT EXISTS connection_observations (
      src             TEXT    NOT NULL,
      dst             TEXT    NOT NULL,
      dport           INTEGER NOT NULL,
      proto           TEXT    NOT NULL,
      routerId        TEXT    NOT NULL,
      firstObservedAt INTEGER NOT NULL,
      lastObservedAt  INTEGER NOT NULL,
      PRIMARY KEY (src, dst, dport, proto, routerId)
    );
    CREATE INDEX IF NOT EXISTS idx_obs_router   ON connection_observations(routerId);
    CREATE INDEX IF NOT EXISTS idx_obs_lastSeen ON connection_observations(lastObservedAt);
`;

/** Detection log, AI conversations, AI usage and AI notification history. */
const EVENTS_SQL = `
    CREATE TABLE IF NOT EXISTS notification_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT    NOT NULL,
      slackSent       INTEGER NOT NULL DEFAULT 0,
      src             TEXT,
      srcMac          TEXT,
      srcVendor       TEXT,
      srcMdnsName     TEXT,
      srcDnsName      TEXT,
      dst             TEXT,
      dstHost         TEXT,
      dport           INTEGER,
      proto           TEXT,
      country         TEXT,
      city            TEXT,
      org             TEXT,
      threatSource    TEXT,
      threatTag       TEXT,
      threatConfidence TEXT,
      detectedAt      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nlog_detectedAt ON notification_log(detectedAt);
    CREATE TABLE IF NOT EXISTS ai_notification_events (
      eventId          TEXT PRIMARY KEY,
      triggerType      TEXT NOT NULL CHECK(triggerType IN ('scheduled', 'threat', 'manual', 'test')),
      triggerKey       TEXT UNIQUE,
      cause            TEXT NOT NULL,
      createdAt        INTEGER NOT NULL,
      rangeFrom        INTEGER NOT NULL,
      rangeTo          INTEGER NOT NULL,
      status           TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
      provider         TEXT NOT NULL,
      model            TEXT NOT NULL,
      body             TEXT,
      slackSent        INTEGER NOT NULL DEFAULT 0,
      inputTokens      INTEGER NOT NULL DEFAULT 0 CHECK(inputTokens >= 0),
      outputTokens     INTEGER NOT NULL DEFAULT 0 CHECK(outputTokens >= 0),
      totalTokens      INTEGER NOT NULL DEFAULT 0 CHECK(totalTokens >= 0),
      estimatedCostUsd REAL,
      errorCode        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_notification_created
      ON ai_notification_events(createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_notification_cause
      ON ai_notification_events(triggerType, cause, createdAt DESC);
`;

module.exports = { CONNECTIONS_SQL, OBSERVATIONS_SQL, EVENTS_SQL };
