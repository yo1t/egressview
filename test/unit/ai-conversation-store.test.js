'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { describe, it } = require('node:test');
const { createAiConversationStore } = require('../../src/ai-conversation-store');
const { runMigrations, SCHEMA_VERSION } = require('../../src/db-migrate');

function storeHarness() {
  const db = new Database(':memory:');
  runMigrations(db, ':memory:');
  return { db, store: createAiConversationStore({ getDb: () => db }) };
}

describe('append-only AI conversation store', () => {
  it('creates v6 tables and appends messages in display order', () => {
    const { db, store } = storeHarness();
    assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    store.createConversation({ conversationId: 'c1', createdAt: 1, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1 });
    store.appendMessage({
      messageId: 'm1', conversationId: 'c1', requestId: 'r1', role: 'user', body: 'question',
      createdAt: 2, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1, status: 'complete', errorCode: null,
      sourceKind: 'router', sourceId: 'router-1',
    });
    store.appendMessage({
      messageId: 'm2', conversationId: 'c1', requestId: 'r1', role: 'assistant', body: 'answer',
      createdAt: 3, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1, status: 'complete', errorCode: null,
      sourceKind: 'router', sourceId: 'router-1',
    });
    db.prepare(`INSERT INTO ai_usage VALUES
      ('u1', 'r1', 'c1', 'chat', 3, 'ollama', 'm1', 10, 4, 14, 0, 'v1', 0, 0)`
    ).run();
    const messages = store.getMessages('c1');
    assert.deepEqual(messages.map(row => row.body), ['question', 'answer']);
    assert.equal(messages[0].usageTotalTokens, null);
    assert.equal(messages[1].usageInputTokens, 10);
    assert.equal(messages[1].usageOutputTokens, 4);
    assert.equal(messages[1].usageTotalTokens, 14);
    assert.equal(messages[1].estimatedCostUsd, 0);
    assert.equal(messages[1].pricingVersion, 'v1');
    assert.deepEqual(messages.map(row => [row.sourceKind, row.sourceId]), [
      ['router', 'router-1'], ['router', 'router-1'],
    ]);
    assert.equal(store.listConversations()[0].messageCount, 2);
    assert.deepEqual(store.getStorageStats(), { conversations: 1, messages: 2, bodyBytes: 14 });
    db.close();
  });

  it('does not overwrite or duplicate a request role', () => {
    const { db, store } = storeHarness();
    store.createConversation({ conversationId: 'c1', createdAt: 1, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1 });
    const base = {
      messageId: 'm1', conversationId: 'c1', requestId: 'r1', role: 'user', body: 'original',
      createdAt: 2, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1, status: 'complete', errorCode: null,
    };
    store.appendMessage(base);
    const replay = store.appendMessage({ ...base, messageId: 'm2', body: 'replacement' });
    assert.equal(replay.body, 'original');
    assert.equal(store.getMessages('c1').length, 1);
    assert.equal(store.deleteConversation('c1'), true);
    assert.equal(store.getMessages('c1').length, 0);
    db.close();
  });

  it('keeps the original source scope on an idempotent replay', () => {
    const { db, store } = storeHarness();
    store.createConversation({ conversationId: 'c1', createdAt: 1, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1 });
    const base = {
      messageId: 'm1', conversationId: 'c1', requestId: 'r1', role: 'user', body: 'original',
      createdAt: 2, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1,
      status: 'complete', errorCode: null, sourceKind: 'router', sourceId: 'router-1',
    };
    store.appendMessage(base);
    const replay = store.appendMessage({
      ...base, messageId: 'm2', sourceKind: 'agent', sourceId: 'agent-1',
    });
    assert.equal(replay.sourceKind, 'router');
    assert.equal(replay.sourceId, 'router-1');
    db.close();
  });

  it('restores the append-only history after reopening the database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-ai-history-'));
    const dbPath = path.join(dir, 'history.db');
    let db = new Database(dbPath);
    runMigrations(db, dbPath);
    let store = createAiConversationStore({ getDb: () => db });
    store.createConversation({ conversationId: 'c1', createdAt: 1, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1 });
    store.appendMessage({
      messageId: 'm1', conversationId: 'c1', requestId: 'r1', role: 'user', body: 'survives restart',
      createdAt: 2, provider: 'ollama', model: 'm1', rangeFrom: 0, rangeTo: 1, status: 'complete', errorCode: null,
      sourceKind: 'agent', sourceId: 'agent-1',
    });
    db.close();
    db = new Database(dbPath);
    store = createAiConversationStore({ getDb: () => db });
    assert.equal(store.getMessages('c1')[0].body, 'survives restart');
    assert.equal(store.getMessages('c1')[0].sourceId, 'agent-1');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
