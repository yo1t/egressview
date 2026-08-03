// Guard-path tests for src/ai-notification-service.js (P2-69)
// Run: node --test test/unit/ai-notification-service-guards.test.js
//
// The existing suite covers scheduling helpers and the happy path. These cases
// cover the refusals instead: the ones that stop this service from spending
// money, from running twice at once, from sending a cloud request without
// consent, and from reporting success when nothing was delivered.

'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createAiNotificationService,
  CLOUD_PROVIDERS,
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
    hasAiNotificationTriggerKey: () => false,
    countAiNotifications: () => 0,
    latestAiNotification: () => null,
  };
}

function build(overrides = {}) {
  const history = overrides.history || baseHistory();
  const emitted = [];
  const slackCalls = [];
  const instance = createAiNotificationService({
    aiProvider: overrides.aiProvider || {
      getPublicConfig: () => ({ provider: 'ollama', models: { ollama: 'qwen3' } }),
      generateInsight: async () => ({
        text: 'stable', provider: 'ollama', model: 'qwen3', generatedAt: 1_000,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    },
    history,
    threatIntel: { matchThreatIntel: () => null },
    devices: null,
    asus: null,
    notifier: overrides.notifier || {
      sendAiNotification: async (payload) => { slackCalls.push(payload); return true; },
      getConfig: () => ({ enabled: true, tokenSet: true, userId: 'U1' }),
    },
    getRouters: () => [],
    getLanguage: overrides.getLanguage || (() => 'en'),
    now: overrides.now || (() => 1_000),
    emit: (name, payload) => emitted.push({ name, payload }),
    setIntervalFn: overrides.setIntervalFn,
    clearIntervalFn: overrides.clearIntervalFn,
  });
  return { instance, history, emitted, slackCalls };
}

describe('AI通知: 実行前ガード', () => {
  it('providerがdisabledなら実行しない', async () => {
    const { instance } = build({
      aiProvider: { getPublicConfig: () => ({ provider: 'disabled' }), generateInsight: async () => ({}) },
    });
    await assert.rejects(instance.run({ triggerType: 'manual' }), /disabled/);
  });

  it('cloud providerは同意なしで実行しない', async () => {
    const provider = [...CLOUD_PROVIDERS][0];
    const { instance } = build({
      aiProvider: {
        getPublicConfig: () => ({ provider }),
        generateInsight: async () => { throw new Error('must not be called'); },
      },
    });
    await assert.rejects(
      instance.run({ triggerType: 'manual' }),
      (error) => error.code === 'AI_CONSENT_REQUIRED'
    );
  });

  it('その場の同意確認があれば cloud provider でも実行する', async () => {
    const provider = [...CLOUD_PROVIDERS][0];
    let called = false;
    const { instance } = build({
      aiProvider: {
        getPublicConfig: () => ({ provider }),
        generateInsight: async () => {
          called = true;
          return { text: 't', provider, model: 'm', generatedAt: 1_000, usage: {} };
        },
      },
    });
    await instance.run({ triggerType: 'manual', consentConfirmed: true });
    assert.equal(called, true);
  });

  it('同一 triggerKey は二度実行しない', async () => {
    const history = baseHistory();
    history.hasAiNotificationTriggerKey = () => true;
    const { instance } = build({ history });
    const result = await instance.run({ triggerType: 'scheduled', triggerKey: 'k1' });
    assert.deepEqual(result, { skipped: true, reason: 'already-run' });
    assert.equal(history.events.length, 0, 'スキップ時は履歴を書かないこと');
  });

  it('実行中の二重起動を AI_BUSY で拒否する', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { instance } = build({
      aiProvider: {
        getPublicConfig: () => ({ provider: 'ollama' }),
        generateInsight: async () => {
          await gate;
          return { text: 't', provider: 'ollama', model: 'm', generatedAt: 1_000, usage: {} };
        },
      },
    });
    const first = instance.run({ triggerType: 'manual' });
    await assert.rejects(
      instance.run({ triggerType: 'manual' }),
      (error) => error.code === 'AI_BUSY'
    );
    release();
    await first;
    // The lock must clear, or one in-flight run would disable the feature.
    await instance.run({ triggerType: 'manual' });
  });

  it('provider が失敗しても実行ロックを解放する', async () => {
    let attempt = 0;
    const { instance } = build({
      aiProvider: {
        getPublicConfig: () => ({ provider: 'ollama' }),
        generateInsight: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('provider exploded');
          return { text: 't', provider: 'ollama', model: 'm', generatedAt: 1_000, usage: {} };
        },
      },
    });
    await assert.rejects(instance.run({ triggerType: 'manual' }), /exploded/);
    await instance.run({ triggerType: 'manual' });
    assert.equal(attempt, 2);
  });
});

describe('AI通知: 配信', () => {
  it('Slackのみ指定で送信に失敗すれば失敗として扱う', async () => {
    const { instance } = build({
      notifier: {
        sendAiNotification: async () => false,
        getConfig: () => ({ enabled: true, tokenSet: true, userId: 'U1' }),
      },
    });
    instance.configure({ destinations: { slack: true, ui: false } });
    await assert.rejects(
      instance.run({ triggerType: 'manual' }),
      (error) => error.code === 'AI_NOTIFICATION_DELIVERY_FAILED'
    );
  });

  it('UI履歴も有効ならSlack失敗でも成功扱いにする', async () => {
    const { instance, history } = build({
      notifier: {
        sendAiNotification: async () => false,
        getConfig: () => ({ enabled: true, tokenSet: true, userId: 'U1' }),
      },
    });
    instance.configure({ destinations: { slack: true, ui: true } });
    await instance.run({ triggerType: 'manual' });
    assert.equal(history.events.length, 1);
    assert.equal(history.events[0].slackSent, 0);
  });

  it('Slack未指定なら送信を試みない', async () => {
    const { instance, slackCalls } = build();
    instance.configure({ destinations: { slack: false, ui: true } });
    await instance.run({ triggerType: 'manual' });
    assert.equal(slackCalls.length, 0);
  });

  it('使用量を記録する', async () => {
    const { instance, history } = build();
    await instance.run({ triggerType: 'manual' });
    assert.equal(history.usage.length, 1);
    assert.equal(history.usage[0].kind, 'analysis');
  });
});

describe('AI通知: testDelivery', () => {
  it('Slack成功時は complete を記録しAIを呼ばない', async () => {
    let generated = false;
    const { instance, history } = build({
      aiProvider: {
        getPublicConfig: () => ({ provider: 'ollama' }),
        generateInsight: async () => { generated = true; return {}; },
      },
    });
    instance.configure({ destinations: { slack: true, ui: true } });
    const event = await instance.testDelivery();
    assert.equal(event.status, 'complete');
    assert.equal(generated, false, 'テスト送信はAI/tokenを消費しないこと');
    assert.equal(history.events.length, 1);
  });

  it('Slack失敗時は failed を記録して投げる', async () => {
    const { instance, history } = build({
      notifier: {
        sendAiNotification: async () => false,
        getConfig: () => ({ enabled: true, tokenSet: true, userId: 'U1' }),
      },
    });
    instance.configure({ destinations: { slack: true, ui: true } });
    await assert.rejects(
      instance.testDelivery(),
      (error) => error.code === 'AI_NOTIFICATION_DELIVERY_FAILED'
    );
    assert.equal(history.events[0].status, 'failed');
  });

  it('UI履歴無効なら body を保存しない', async () => {
    const { instance, history } = build();
    instance.configure({ destinations: { slack: true, ui: false } });
    await instance.testDelivery();
    assert.equal(history.events[0].body, null);
  });

  it('言語設定に応じて本文を切り替える', async () => {
    const { instance, history } = build({ getLanguage: () => 'ja' });
    instance.configure({ destinations: { slack: false, ui: true } });
    await instance.testDelivery();
    assert.match(history.events[0].body, /AIイベント通知/);
  });
});

describe('AI通知: start / stop / publicStatus', () => {
  it('startは二重にtimerを作らない', () => {
    const created = [];
    const { instance } = build({
      setIntervalFn: (fn, ms) => { const t = { fn, ms, unref() {} }; created.push(t); return t; },
      clearIntervalFn: () => {},
    });
    instance.start();
    instance.start();
    assert.equal(created.length, 1);
    instance.stop();
  });

  it('stopでtimerを解放し、再度startできる', () => {
    const created = [];
    const cleared = [];
    const { instance } = build({
      setIntervalFn: (fn) => { const t = { fn, unref() {} }; created.push(t); return t; },
      clearIntervalFn: (t) => cleared.push(t),
    });
    instance.start();
    instance.stop();
    instance.start();
    assert.equal(created.length, 2);
    assert.equal(cleared.length, 1);
    instance.stop();
  });

  it('stopはtimerが無くても安全', () => {
    const { instance } = build({ setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
    assert.doesNotThrow(() => instance.stop());
  });

  it('publicStatusはSlack readinessを反映する', () => {
    const { instance } = build({
      notifier: {
        sendAiNotification: async () => true,
        getConfig: () => ({ enabled: true, tokenSet: false, userId: 'U1' }),
      },
    });
    // A token that is not set means Slack cannot actually deliver.
    assert.equal(instance.publicStatus().slackReady, false);
  });

  it('publicStatusはcloud providerの同意状態を反映する', () => {
    const provider = [...CLOUD_PROVIDERS][0];
    const { instance } = build({
      aiProvider: { getPublicConfig: () => ({ provider }), generateInsight: async () => ({}) },
    });
    assert.equal(instance.publicStatus().automationReady, false);
    instance.configure({ automationConsent: true, automationProvider: provider });
    assert.equal(instance.publicStatus().automationReady, true);
  });

  it('同意したproviderから変更すると自動実行が止まる', () => {
    const provider = [...CLOUD_PROVIDERS][0];
    let current = provider;
    const { instance } = build({
      aiProvider: { getPublicConfig: () => ({ provider: current }), generateInsight: async () => ({}) },
    });
    instance.configure({ automationConsent: true, automationProvider: provider });
    assert.equal(instance.publicStatus().automationReady, true);
    current = [...CLOUD_PROVIDERS][1] || 'ollama';
    // Consent is per provider; switching must require consenting again.
    assert.equal(
      instance.publicStatus().automationReady,
      !CLOUD_PROVIDERS.has(current)
    );
  });
});

describe('AI通知: configure', () => {
  it('不正なtimezoneを拒否する', () => {
    const { instance } = build();
    assert.throws(() => instance.configure({ timezone: 'Not/AZone' }));
  });

  it('exportConfigは内部stateのコピーを返す', () => {
    const { instance } = build();
    const exported = instance.exportConfig();
    exported.rangeHours = 9999;
    assert.notEqual(instance.exportConfig().rangeHours, 9999);
  });
});
