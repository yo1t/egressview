'use strict';

function createAiConversationStore({ getDb }) {
  function requireDb() {
    const db = getDb();
    if (!db) throw new Error('history database is not initialized');
    return db;
  }

  function createConversation(row) {
    requireDb().prepare(`
      INSERT OR IGNORE INTO ai_conversations
        (conversationId, createdAt, provider, model, rangeFrom, rangeTo)
      VALUES (@conversationId, @createdAt, @provider, @model, @rangeFrom, @rangeTo)
    `).run(row);
    return getConversation(row.conversationId);
  }

  function getConversation(conversationId) {
    return requireDb().prepare(
      'SELECT * FROM ai_conversations WHERE conversationId = ?'
    ).get(conversationId) || null;
  }

  function appendMessage(row) {
    const database = requireDb();
    const insertMessage = database.prepare(`
      INSERT OR IGNORE INTO ai_messages
        (messageId, conversationId, requestId, role, body, createdAt,
         provider, model, rangeFrom, rangeTo, status, errorCode)
      VALUES
        (@messageId, @conversationId, @requestId, @role, @body, @createdAt,
         @provider, @model, @rangeFrom, @rangeTo, @status, @errorCode)
    `);
    const insertScope = database.prepare(`
      INSERT INTO ai_message_scopes (messageId, sourceKind, sourceId)
      VALUES (?, ?, ?)
    `);
    const findMessage = database.prepare(`
      SELECT m.*, s.sourceKind, s.sourceId
      FROM ai_messages m
      LEFT JOIN ai_message_scopes s ON s.messageId = m.messageId
      WHERE m.requestId = ? AND m.role = ?
    `);
    return database.transaction(message => {
      const inserted = insertMessage.run(message);
      if (inserted.changes && message.sourceKind && message.sourceId) {
        insertScope.run(message.messageId, message.sourceKind, message.sourceId);
      }
      return findMessage.get(message.requestId, message.role);
    })(row);
  }

  function listConversations(limit = 100) {
    return requireDb().prepare(`
      SELECT c.*, COUNT(m.messageId) AS messageCount,
             COALESCE(SUM(LENGTH(m.body)), 0) AS bodyBytes,
             MAX(m.createdAt) AS lastMessageAt
      FROM ai_conversations c
      LEFT JOIN ai_messages m ON m.conversationId = c.conversationId
      GROUP BY c.conversationId
      ORDER BY COALESCE(MAX(m.createdAt), c.createdAt) DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(100, Number(limit) || 100)));
  }

  function getMessages(conversationId, limit = 500) {
    // rowid (monotonic insertion order) is the tiebreaker so messages created
    // in the same millisecond keep stable append order — messageId is a random
    // UUID and must not decide ordering.
    return requireDb().prepare(`
      SELECT m.*,
             s.sourceKind,
             s.sourceId,
             u.inputTokens AS usageInputTokens,
             u.outputTokens AS usageOutputTokens,
             u.totalTokens AS usageTotalTokens,
             u.estimatedCostUsd,
             u.pricingVersion
      FROM ai_messages m
      LEFT JOIN ai_message_scopes s ON s.messageId = m.messageId
      LEFT JOIN ai_usage u
        ON m.role = 'assistant' AND u.requestId = m.requestId AND u.kind = 'chat'
      WHERE m.conversationId = ?
      ORDER BY m.createdAt ASC, m.rowid ASC LIMIT ?
    `).all(conversationId, Math.max(1, Math.min(500, Number(limit) || 500)));
  }

  function deleteConversation(conversationId) {
    const database = requireDb();
    return database.transaction(id => {
      database.prepare(`
        DELETE FROM ai_message_scopes
        WHERE messageId IN (SELECT messageId FROM ai_messages WHERE conversationId = ?)
      `).run(id);
      database.prepare('DELETE FROM ai_messages WHERE conversationId = ?').run(id);
      return database.prepare('DELETE FROM ai_conversations WHERE conversationId = ?').run(id).changes > 0;
    })(conversationId);
  }

  function getStorageStats() {
    return requireDb().prepare(`
      SELECT (SELECT COUNT(*) FROM ai_conversations) AS conversations,
             (SELECT COUNT(*) FROM ai_messages) AS messages,
             (SELECT COALESCE(SUM(LENGTH(body)), 0) FROM ai_messages) AS bodyBytes
    `).get();
  }

  return {
    appendMessage,
    createConversation,
    deleteConversation,
    getConversation,
    getMessages,
    getStorageStats,
    listConversations,
  };
}

module.exports = { createAiConversationStore };
