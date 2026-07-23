'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createAiNotificationService,
  dayBounds,
  scheduleKey,
  threatCauses,
} = require('../../src/ai-notification-service');

function baseHistory() {
  const events = [];
  const usage = [];
  return {
    events,
    usage,
    countFactsByTimeRange: () => ({ connections: 2, devices: 1, destinations: 1 }),
    groupDstByTimeRange: () => [],
    groupServiceByTimeRange: () => [],
    groupSrcForDstsByTimeRange: () => [],
    groupSrcByTimeRange: () => [],
    appendAiUsage: row => usage.push(row),
    appendAiNotification: row => events.push(row),
    hasAiNotificationTriggerKey: key => events.some(row => row.triggerKey === key && row.status === 'complete'),
    countAiNotifications: () => 0,
    latestAiNotification: () => null,
  };
}

function service(overrides = {}) {
  const history = overrides.history || baseHistory();
  const provider = overrides.provider || {
    getPublicConfig: () => ({ provider: 'ollama', models: { ollama: 'qwen3' } }),
    generateInsight: async () => ({
      text: 'Network is stable.',
      provider: 'ollama',
      model: 'qwen3',
      generatedAt: 1_000,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      estimatedCostUsd: 0,
    }),
  };
  return {
    history,
    instance: createAiNotificationService({
      aiProvider: provider,
      history,
      threatIntel: { matchThreatIntel: () => null },
      devices: null,
      asus: null,
      notifier: { sendAiNotification: async () => true },
      getRouters: () => [],
      getLanguage: () => 'en',
      now: overrides.now || (() => 1_000),
      emit: () => {},
    }),
  };
}

describe('AI notification scheduling helpers', () => {
  it('creates one local-time key for daily and weekly schedules', () => {
    const monday = Date.parse('2026-07-20T00:00:00Z'); // 09:00 Asia/Tokyo
    const config = { frequency: 'daily', time: '09:00', timezone: 'Asia/Tokyo', weekday: 1 };
    assert.equal(scheduleKey(config, monday), 'scheduled:daily:2026-07-20:09:00');
    assert.equal(scheduleKey({ ...config, frequency: 'weekly' }, monday),
      'scheduled:weekly:2026-07-20:09:00');
    assert.equal(scheduleKey({ ...config, frequency: 'weekly', weekday: 2 }, monday), null);
  });

  it('identifies danger, new destination, and aggregate increase causes', () => {
    const facts = {
      current: { danger: 2, warn: 4 },
      previous: { danger: 0, warn: 1 },
    };
    const config = {
      threat: { dangerThreshold: 1, newDestinationsThreshold: 1, increaseThreshold: 3 },
    };
    assert.deepEqual(threatCauses(facts, ['bad.example'], [], config),
      ['danger', 'new-destination', 'increase']);
  });

  it('uses exact local-day bounds across daylight-saving changes', () => {
    const spring = dayBounds(Date.parse('2026-03-08T16:00:00Z'), 'America/New_York');
    assert.equal(spring.from, Date.parse('2026-03-08T05:00:00Z'));
    assert.equal(spring.to, Date.parse('2026-03-09T04:00:00Z'));

    const fall = dayBounds(Date.parse('2026-11-01T17:00:00Z'), 'America/New_York');
    assert.equal(fall.from, Date.parse('2026-11-01T04:00:00Z'));
    assert.equal(fall.to, Date.parse('2026-11-02T05:00:00Z'));
  });
});

describe('AI notification service', () => {
  it('runs an analysis, records usage, and appends a delivery event', async () => {
    const { instance, history } = service();
    instance.configure({
      destinations: { ui: true, slack: true },
      rangeHours: 1,
    });
    const event = await instance.run({ triggerType: 'manual', cause: 'run-now' });
    assert.equal(event.status, 'complete');
    assert.equal(event.body, 'Network is stable.');
    assert.equal(event.slackSent, 1);
    assert.equal(history.events.length, 1);
    assert.equal(history.usage.length, 1);
    assert.equal(history.usage[0].kind, 'analysis');
  });

  it('requires durable automation consent for cloud scheduled runs', async () => {
    const provider = {
      getPublicConfig: () => ({ provider: 'openai', models: { openai: 'gpt-test' } }),
      generateInsight: async () => { throw new Error('must not run'); },
    };
    const { instance, history } = service({ provider });
    await assert.rejects(
      instance.run({ triggerType: 'scheduled', triggerKey: 'scheduled:key' }),
      error => error.code === 'AI_CONSENT_REQUIRED'
    );
    assert.equal(history.events.length, 0);
  });

  it('does not rerun an already completed schedule key', async () => {
    const { instance, history } = service();
    history.events.push({ triggerKey: 'scheduled:key', status: 'complete' });
    const result = await instance.run({ triggerType: 'scheduled', triggerKey: 'scheduled:key' });
    assert.deepEqual(result, { skipped: true, reason: 'already-run' });
    assert.equal(history.events.length, 1);
  });

  it('tests delivery without invoking the AI provider', async () => {
    let generated = 0;
    const provider = {
      getPublicConfig: () => ({ provider: 'ollama', models: { ollama: 'qwen3' } }),
      generateInsight: async () => { generated++; },
    };
    const { instance, history } = service({ provider });
    const event = await instance.testDelivery();
    assert.equal(event.triggerType, 'test');
    assert.equal(generated, 0);
    assert.equal(history.events.length, 1);
  });

  it('fails a Slack delivery test when Slack cannot receive the message', async () => {
    const history = baseHistory();
    const instance = createAiNotificationService({
      aiProvider: {
        getPublicConfig: () => ({ provider: 'ollama', models: { ollama: 'qwen3' } }),
      },
      history,
      threatIntel: { matchThreatIntel: () => null },
      notifier: { sendAiNotification: async () => false },
      getRouters: () => [],
      now: () => 1_000,
    });
    instance.configure({ destinations: { ui: true, slack: true } });

    await assert.rejects(instance.testDelivery(),
      error => error.code === 'AI_NOTIFICATION_DELIVERY_FAILED');
    assert.equal(history.events[0].status, 'failed');
    assert.equal(history.events[0].errorCode, 'AI_NOTIFICATION_DELIVERY_FAILED');
  });
});
