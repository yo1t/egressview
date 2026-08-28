'use strict';

/**
 * The objects `initDb` creates directly, after the migrations have run.
 *
 * Split out of `history.js` (P2-97). What this file actually is took two
 * passes to state correctly, and the first attempt was wrong in a way worth
 * recording.
 *
 * **It is not the schema of a fresh database.** `initDb` runs migrations
 * first, and on an empty database those build everything from version 0
 * upward. Measured 2026-08-29: migrations create 42 objects, and everything
 * below then creates 6.
 *
 * **Nor is it dead.** Migrations never run again once `user_version` reaches
 * the current version, so on a database that says 19 while an object is
 * missing -- a restored upload, an interrupted operation -- these statements
 * are the only thing that puts anything back.
 *
 * **What it repairs is an accident of history, not a design.** Dropping each
 * object in turn from a migrated database and re-running `initDb`'s sequence,
 * measured 2026-08-29:
 *
 *   repaired      13 of 48 -- connections, notification_log, routers,
 *                 connection_observations, ai_notification_events, and 8 indexes
 *   not repaired  35 of 48 -- including agents, agent_observations,
 *                 audit_events, api_identities and every ai_* table
 *
 * Two of the repaired five are load-bearing on every install: `connections`
 * and `notification_log` predate migrations, so nothing else creates them at
 * all. The rest of the coverage is whatever happened to get written here.
 *
 * **A partial repair is not a safety net.** A database missing
 * `agent_observations` fails at runtime whatever happens to `connections`, and
 * silently recreating `connections` empty would present data loss as a working
 * system. Making this either complete or explicit is open work; see
 * `test/unit/history-schema.test.js`, which pins both halves so the split
 * cannot drift unnoticed.
 *
 * Every statement is `IF NOT EXISTS`. The three definitions that duplicate
 * what migrations build have columns identical to the migrated tables, checked
 * by the same test.
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
