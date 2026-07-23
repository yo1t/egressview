'use strict';

function createAiNotificationStore({ getDb }) {
  function appendAiNotification(event) {
    const db = getDb();
    if (!db) throw new Error('Database is not initialized');
    db.prepare(`
      INSERT INTO ai_notification_events (
        eventId, triggerType, triggerKey, cause, createdAt, rangeFrom, rangeTo,
        status, provider, model, body, slackSent, inputTokens, outputTokens,
        totalTokens, estimatedCostUsd, errorCode
      ) VALUES (
        @eventId, @triggerType, @triggerKey, @cause, @createdAt, @rangeFrom, @rangeTo,
        @status, @provider, @model, @body, @slackSent, @inputTokens, @outputTokens,
        @totalTokens, @estimatedCostUsd, @errorCode
      )
    `).run({
      triggerKey: null,
      cause: '',
      provider: '',
      model: '',
      body: null,
      slackSent: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      errorCode: null,
      ...event,
    });
  }

  function listAiNotifications(limit = 50) {
    const db = getDb();
    if (!db) return [];
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    return db.prepare(`
      SELECT * FROM ai_notification_events
      ORDER BY createdAt DESC, eventId DESC LIMIT ?
    `).all(bounded);
  }

  function countAiNotifications(from, to, triggerType = null) {
    const db = getDb();
    if (!db) return 0;
    if (triggerType) {
      return db.prepare(`
        SELECT COUNT(*) AS n FROM ai_notification_events
        WHERE createdAt >= ? AND createdAt < ? AND triggerType = ? AND status = 'complete'
      `).get(from, to, triggerType).n;
    }
    return db.prepare(`
      SELECT COUNT(*) AS n FROM ai_notification_events
      WHERE createdAt >= ? AND createdAt < ? AND status = 'complete'
    `).get(from, to).n;
  }

  function latestAiNotification(cause, triggerType = null) {
    const db = getDb();
    if (!db) return null;
    if (triggerType) {
      return db.prepare(`
        SELECT * FROM ai_notification_events
        WHERE cause = ? AND triggerType = ?
        ORDER BY createdAt DESC LIMIT 1
      `).get(cause, triggerType) || null;
    }
    return db.prepare(`
      SELECT * FROM ai_notification_events
      WHERE cause = ? ORDER BY createdAt DESC LIMIT 1
    `).get(cause) || null;
  }

  function hasAiNotificationTriggerKey(triggerKey) {
    const db = getDb();
    if (!db || !triggerKey) return false;
    return !!db.prepare(`
      SELECT 1 FROM ai_notification_events WHERE triggerKey = ? AND status = 'complete'
    `).get(triggerKey);
  }

  return {
    appendAiNotification,
    countAiNotifications,
    hasAiNotificationTriggerKey,
    latestAiNotification,
    listAiNotifications,
  };
}

module.exports = { createAiNotificationStore };
