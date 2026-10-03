'use strict';

// The notification log, read by the period and the source a view is scoped to.
//
// Its own module so the read thread can answer it as well as the history
// module (P3-184). Scoped to a router or an agent, each notification looks for
// a matching connection in that source's observations, and on 2026-10-03 the
// request took 24.9 s -- on the thread that answers every other request.
//
// Each scope is two branches. A notification names its destination and port
// -- every one of the 377,319 on the Hub on 2026-10-03 did -- and is matched
// on the full key, which the tables' indexes can look up. The original
// "a missing part matches anything" form is kept only for a notification that
// lacks one. Written as one condition, the `IS NULL OR` kept SQLite from using
// the destination at all: it walked every observation of the sender for each
// notification. On the Hub, scoped to one Mac (1.27M observations) that took
// 243 s, past the read thread's two-minute limit; scoped to the Cisco router,
// 97.7 s. Split, the same 2,000 rows came back in 82 ms and 128 ms.

function createNotificationLogQuery({ getDb }) {
  function queryNotificationLog(from, to, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const conditions = [];
    const params = [];
    if (from != null) { conditions.push('detectedAt >= ?'); params.push(from); }
    if (to   != null) { conditions.push('detectedAt <= ?'); params.push(to); }
    if (sourceScope?.sourceKind === 'router') {
      conditions.push(`(
        (notification_log.dst IS NOT NULL AND notification_log.dport IS NOT NULL AND EXISTS (
          SELECT 1 FROM connections c
          JOIN connection_observations o
            ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
          WHERE c.src = notification_log.src
            AND c.dst = notification_log.dst
            AND c.dport = notification_log.dport
            AND (notification_log.proto IS NULL OR LOWER(c.proto) = LOWER(notification_log.proto))
            AND o.routerId = ?
        ))
        OR ((notification_log.dst IS NULL OR notification_log.dport IS NULL) AND EXISTS (
          SELECT 1 FROM connections c
          JOIN connection_observations o
            ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
          WHERE c.src = notification_log.src
            AND (notification_log.dst IS NULL OR c.dst = notification_log.dst)
            AND (notification_log.dport IS NULL OR c.dport = notification_log.dport)
            AND (notification_log.proto IS NULL OR LOWER(c.proto) = LOWER(notification_log.proto))
            AND o.routerId = ?
        ))
      )`);
      params.push(sourceScope.sourceId, sourceScope.sourceId);
    } else if (sourceScope?.sourceKind === 'agent') {
      conditions.push(`(
        (notification_log.dst IS NOT NULL AND notification_log.dport IS NOT NULL AND EXISTS (
          SELECT 1 FROM agent_observations o
          WHERE o.agentId = ? AND o.localAddress = notification_log.src
            AND o.remoteAddress = notification_log.dst
            AND o.remotePort = notification_log.dport
            AND (notification_log.proto IS NULL OR LOWER(o.networkProtocol) = LOWER(notification_log.proto))
        ))
        OR ((notification_log.dst IS NULL OR notification_log.dport IS NULL) AND EXISTS (
          SELECT 1 FROM agent_observations o
          WHERE o.agentId = ? AND o.localAddress = notification_log.src
            AND (notification_log.dst IS NULL OR o.remoteAddress = notification_log.dst)
            AND (notification_log.dport IS NULL OR o.remotePort = notification_log.dport)
            AND (notification_log.proto IS NULL OR LOWER(o.networkProtocol) = LOWER(notification_log.proto))
        ))
      )`);
      params.push(sourceScope.sourceId, sourceScope.sourceId);
    } else if (sourceScope) {
      throw new TypeError('Unsupported source scope');
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    return db.prepare(
      `SELECT * FROM notification_log${where} ORDER BY detectedAt DESC LIMIT 2000`
    ).all(...params);
  }

  return queryNotificationLog;
}

module.exports = { createNotificationLogQuery };
