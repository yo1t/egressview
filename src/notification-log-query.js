'use strict';

// The notification log, read by the period and the source a view is scoped to.
//
// Its own module so the read thread can answer it as well as the history
// module (P3-184). Scoped to a router or an agent, each notification looks for
// a matching connection in that source's observations, and on 2026-10-03 the
// request took 24.9 s -- on the thread that answers every other request.

function createNotificationLogQuery({ getDb }) {
  function queryNotificationLog(from, to, { sourceScope = null } = {}) {
    const db = getDb();
    if (!db) return [];
    const conditions = [];
    const params = [];
    if (from != null) { conditions.push('detectedAt >= ?'); params.push(from); }
    if (to   != null) { conditions.push('detectedAt <= ?'); params.push(to); }
    if (sourceScope?.sourceKind === 'router') {
      conditions.push(`EXISTS (
        SELECT 1 FROM connections c
        JOIN connection_observations o
          ON o.src = c.src AND o.dst = c.dst AND o.dport = c.dport AND o.proto = c.proto
        WHERE c.src = notification_log.src
          AND (notification_log.dst IS NULL OR c.dst = notification_log.dst)
          AND (notification_log.dport IS NULL OR c.dport = notification_log.dport)
          AND (notification_log.proto IS NULL OR LOWER(c.proto) = LOWER(notification_log.proto))
          AND o.routerId = ?
      )`);
      params.push(sourceScope.sourceId);
    } else if (sourceScope?.sourceKind === 'agent') {
      conditions.push(`EXISTS (
        SELECT 1 FROM agent_observations o
        WHERE o.agentId = ? AND o.localAddress = notification_log.src
          AND (notification_log.dst IS NULL OR o.remoteAddress = notification_log.dst)
          AND (notification_log.dport IS NULL OR o.remotePort = notification_log.dport)
          AND (notification_log.proto IS NULL OR LOWER(o.networkProtocol) = LOWER(notification_log.proto))
      )`);
      params.push(sourceScope.sourceId);
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
