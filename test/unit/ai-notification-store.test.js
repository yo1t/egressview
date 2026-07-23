'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { createAiNotificationStore } = require('../../src/ai-notification-store');

function createStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_notification_events (
      eventId TEXT PRIMARY KEY,
      triggerType TEXT NOT NULL,
      triggerKey TEXT,
      cause TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      rangeFrom INTEGER NOT NULL,
      rangeTo INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      body TEXT,
      slackSent INTEGER NOT NULL DEFAULT 0,
      inputTokens INTEGER NOT NULL DEFAULT 0,
      outputTokens INTEGER NOT NULL DEFAULT 0,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      estimatedCostUsd REAL,
      errorCode TEXT
    )
  `);
  return { db, store: createAiNotificationStore({ getDb: () => db }) };
}

describe('AI notification event store', () => {
  it('appends defaults and lists newest events first', () => {
    const { db, store } = createStore();
    store.appendAiNotification({
      eventId: 'older',
      triggerType: 'test',
      createdAt: 100,
      rangeFrom: 100,
      rangeTo: 100,
      status: 'complete',
    });
    store.appendAiNotification({
      eventId: 'newer',
      triggerType: 'manual',
      createdAt: 200,
      rangeFrom: 100,
      rangeTo: 200,
      status: 'complete',
      body: 'report',
    });

    const events = store.listAiNotifications(10);
    assert.deepEqual(events.map(event => event.eventId), ['newer', 'older']);
    assert.equal(events[1].slackSent, 0);
    assert.equal(events[1].body, null);
    db.close();
  });

  it('counts completed events and detects only completed trigger keys', () => {
    const { db, store } = createStore();
    for (const event of [
      { eventId: 'done', triggerType: 'threat', triggerKey: 'key:done', status: 'complete' },
      { eventId: 'failed', triggerType: 'threat', triggerKey: 'key:failed', status: 'failed' },
      { eventId: 'scheduled', triggerType: 'scheduled', triggerKey: 'key:scheduled', status: 'complete' },
    ]) {
      store.appendAiNotification({
        ...event,
        cause: 'danger',
        createdAt: event.eventId === 'done' ? 100 : 200,
        rangeFrom: 0,
        rangeTo: 200,
      });
    }

    assert.equal(store.countAiNotifications(0, 300), 2);
    assert.equal(store.countAiNotifications(0, 300, 'threat'), 1);
    assert.equal(store.hasAiNotificationTriggerKey('key:done'), true);
    assert.equal(store.hasAiNotificationTriggerKey('key:failed'), false);
    assert.equal(store.latestAiNotification('danger', 'threat').eventId, 'failed');
    assert.equal(store.latestAiNotification('missing'), null);
    db.close();
  });
});
