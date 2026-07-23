'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-insights.js'), 'utf8')
  .replace(/^import\s[^;]+;?\s*$/gm, '')
  .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
  .replace(/initAiInsights\(\);/, '');

class FakeElement {
  constructor() {
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.children = [];
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      toggle: (name, force) => force ? this._classes.add(name) : this._classes.delete(name),
      contains: name => this._classes.has(name),
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
}

function harness({ apiFetch = async () => { throw new Error('Unexpected request'); } } = {}) {
  const ids = new Map();
  const cards = new Map();
  const get = id => {
    if (!ids.has(id)) ids.set(id, new FakeElement());
    return ids.get(id);
  };
  const context = {
    Intl, URLSearchParams, Date, AbortController, Uint8Array, Math, currentLang: 'en', _BASE: '',
    t: key => key,
    tVars: (key, values) => `${key}:${JSON.stringify(values)}`,
    apiFetch,
    getTimeRange: () => ({ from: 1, to: 2 }),
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    document: {
      getElementById: get,
      createElement: () => new FakeElement(),
      querySelector(selector) {
        if (!cards.has(selector)) cards.set(selector, new FakeElement());
        return cards.get(selector);
      },
      querySelectorAll: () => [],
    },
    setInterval, clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'public/js/ai-insights.js' });
  return { context, get, cards };
}

describe('AI insights view', () => {
  it('formats USD estimates as dollars in English and explicit USD in Japanese', () => {
    const { context } = harness();
    assert.equal(context.formatUsd(0.0012), '$0.0012');
    context.currentLang = 'ja';
    assert.match(context.formatUsd(0.0012), /^USD\s*0\.0012$/);
  });

  it('calculates percentage deltas without dividing by zero', () => {
    const { context } = harness();
    assert.deepEqual({ ...context.deltaSummary(15, 10) }, { delta: 5, percent: 50 });
    assert.deepEqual({ ...context.deltaSummary(3, 0) }, { delta: 3, percent: null });
  });

  it('renders safe text and highlights nonzero findings', () => {
    const { context, get, cards } = harness();
    context.renderFacts({
      collection: {
        health: 'ok', enabledCount: 1, readyCount: 1, lastUpdatedAt: 100,
        routers: [{ displayName: '<b>Router</b>', enabled: true, ready: true, sessionCount: 7 }],
      },
      current: { connections: 5, devices: 2, destinations: 3, warn: 0, danger: 1 },
      previous: { connections: 4, devices: 2, destinations: 2, warn: 0, danger: 0 },
    });
    assert.equal(get('ai-value-connections').textContent, '5');
    assert.equal(get('ai-router-list').children[0].textContent, '<b>Router</b> · 7');
    assert.equal(cards.get('[data-ai-metric="danger"]').classList.contains('has-findings'), true);
    assert.equal(cards.get('[data-ai-metric="warn"]').classList.contains('has-findings'), false);
  });

  it('shows only the explicit cancel control while analysis is running', () => {
    const { context, get } = harness();
    context.setAnalysisRunning(true);
    assert.equal(get('ai-analyze-btn').disabled, true);
    assert.equal(get('ai-cancel-btn').classList.contains('is-hidden'), false);
    context.setAnalysisRunning(false);
    assert.equal(get('ai-analyze-btn').disabled, false);
    assert.equal(get('ai-cancel-btn').classList.contains('is-hidden'), true);
  });

  it('renders monthly tokens, estimated cost, and an unpriced-model warning', () => {
    const { context, get } = harness();
    context.renderAiUsage({
      pricing: { catalogVersion: '2026-05-27', effectiveFrom: '2026-05-27' },
      current: { requests: 3, pricedRequests: 2, unknownPriceRequests: 1, usageMissingRequests: 0, inputTokens: 1200, outputTokens: 300, totalTokens: 1500, unpricedTokens: 450, estimatedCostUsd: 0.0084, unpricedModels: [{ provider: 'openai', model: 'future-model' }] },
      previous: { requests: 1, pricedRequests: 1, unknownPriceRequests: 0, usageMissingRequests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0004 },
    });
    assert.equal(get('ai-usage-current-tokens').textContent, 'ai.usage.tokens:{"tokens":"1,500"}');
    assert.equal(get('ai-usage-current-detail').textContent, 'ai.usage.detail:{"input":"1,200","output":"300"}');
    assert.equal(get('ai-usage-current-cost').textContent, 'ai.usage.costPartial:{"cost":"$0.0084"}');
    assert.equal(get('ai-usage-current-unpriced').textContent,
      'ai.usage.unpricedDetail:{"tokens":"450","requests":"1"}');
    assert.equal(get('ai-usage-caveat').textContent,
      'ai.usage.unpriced ai.usage.unpricedModels:{"models":"openai/future-model","remaining":""} ' +
      'ai.usage.missing ai.usage.catalog:{"version":"2026-05-27","effective":"2026-05-27"}');
  });

  it('renders persisted conversation messages as untrusted text', () => {
    const { context, get } = harness();
    context.renderChatMessages([
      { role: 'user', status: 'complete', body: '<img src=x onerror=alert(1)>' },
      {
        role: 'assistant', status: 'complete', body: '<script>alert(1)</script>',
        provider: 'anthropic', model: 'claude-sonnet-4-5', usageTotalTokens: 150,
        estimatedCostUsd: 0.0012,
      },
      { role: 'assistant', status: 'failed', body: null, provider: 'openai', model: 'gpt-5.4' },
    ]);
    const children = get('ai-chat-messages').children;
    assert.equal(children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(children[1].children[0].textContent, '<script>alert(1)</script>');
    assert.equal(children[1].children[1].textContent,
      'ai.chat.responseMeta:{"provider":"Anthropic","model":"claude-sonnet-4-5"} · ' +
      'ai.chat.usagePriced:{"tokens":"150","cost":"$0.0012"}');
    assert.equal(children[2].children[0].textContent, 'ai.chat.failed');
    assert.equal(children[2].children[1].textContent,
      'ai.chat.responseMeta:{"provider":"OpenAI","model":"gpt-5.4"} · ai.chat.usageUnavailable');
    assert.equal(children[2].classList.contains('is-failed'), true);
  });

  it('shows zeroed usage sentinel rows as provider usage unavailable', () => {
    const { context, get } = harness();
    context.renderChatMessages([{
      role: 'assistant', body: 'answer', provider: 'anthropic', model: 'claude-test',
      usageInputTokens: 0, usageOutputTokens: 0, usageTotalTokens: 0, estimatedCostUsd: null,
    }]);
    assert.match(get('ai-chat-messages').children[0].children[1].textContent, /ai\.chat\.usageUnavailable/);
  });

  it('renders AI notification configuration and event bodies as untrusted text', () => {
    const { context, get } = harness();
    context.fillNotificationConfig({
      frequency: 'weekly',
      weekday: 2,
      time: '08:30',
      timezone: 'Asia/Tokyo',
      rangeHours: 168,
      destinations: { ui: true, slack: false },
      threat: {
        enabled: true,
        dangerThreshold: 1,
        newDestinationsThreshold: 2,
        increaseThreshold: 3,
      },
      dailyLimit: 3,
      cooldownMinutes: 60,
      automationConsent: true,
    });
    assert.equal(get('ai-notification-frequency').value, 'weekly');
    assert.equal(get('ai-notification-time').value, '08:30');
    assert.equal(get('ai-notification-consent').checked, true);

    context.renderNotificationEvents([{
      triggerType: 'threat',
      status: 'complete',
      createdAt: 1000,
      provider: 'openai',
      model: 'gpt-test',
      slackSent: 1,
      body: '<img src=x onerror=alert(1)>',
    }]);
    const event = get('ai-notification-events').children[0];
    assert.equal(event.children[2].textContent, '<img src=x onerror=alert(1)>');
  });

  it('previews AI notification settings before persisting and closes only after confirmation', async () => {
    const calls = [];
    const config = {
      frequency: 'weekly',
      weekday: 2,
      time: '08:30',
      timezone: 'Asia/Tokyo',
      rangeHours: 168,
      destinations: { ui: true, slack: true },
      threat: {
        enabled: true,
        dangerThreshold: 1,
        newDestinationsThreshold: 2,
        increaseThreshold: 3,
      },
      dailyLimit: 3,
      cooldownMinutes: 60,
      automationConsent: true,
    };
    const { context, get } = harness({
      apiFetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ config }) };
      },
    });
    get('ai-notification-modal').classList.remove('is-hidden');
    get('ai-notification-confirm-modal').classList.add('is-hidden');
    context.fillNotificationConfig(config);

    context.saveNotificationConfig();

    assert.equal(calls.length, 0);
    assert.equal(get('ai-notification-confirm-modal').classList.contains('is-hidden'), false);
    assert.equal(get('ai-notification-summary').children.length, 9);
    assert.match(get('ai-notification-summary').children[0].children[1].textContent, /weekly/);

    await context.confirmNotificationConfig();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/ai/notification-config');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(get('ai-notification-confirm-modal').classList.contains('is-hidden'), true);
    assert.equal(get('ai-notification-modal').classList.contains('is-hidden'), true);
  });

  it('keeps the AI notification confirmation open when persistence fails', async () => {
    const config = {
      frequency: 'off',
      weekday: 0,
      time: '09:00',
      timezone: 'UTC',
      rangeHours: 24,
      destinations: { ui: true, slack: false },
      threat: {
        enabled: false,
        dangerThreshold: 1,
        newDestinationsThreshold: 1,
        increaseThreshold: 1,
      },
      dailyLimit: 3,
      cooldownMinutes: 60,
      automationConsent: false,
    };
    const { context, get } = harness({
      apiFetch: async () => ({
        ok: false,
        json: async () => ({ error: 'disk full' }),
      }),
    });
    get('ai-notification-modal').classList.remove('is-hidden');
    get('ai-notification-confirm-modal').classList.add('is-hidden');
    context.fillNotificationConfig(config);
    context.saveNotificationConfig();

    await context.confirmNotificationConfig();

    assert.equal(get('ai-notification-confirm-modal').classList.contains('is-hidden'), false);
    assert.equal(get('ai-notification-modal').classList.contains('is-hidden'), false);
    assert.equal(get('ai-notification-confirm-status').textContent, 'disk full');
    assert.equal(get('ai-notification-confirm-status').classList.contains('err'), true);
  });

  it('keeps a server-persisted question visible when provider inference fails', async () => {
    const calls = [];
    const apiFetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/api/ai/chat')) {
        return {
          ok: false,
          json: async () => ({ conversationId: 'conversation-1', error: 'Provider request failed (400)' }),
        };
      }
      if (url.endsWith('/api/ai/conversations')) {
        return {
          ok: true,
          json: async () => ({
            conversations: [{ conversationId: 'conversation-1', createdAt: 1, messageCount: 2 }],
            storage: { conversations: 1, messages: 2, bodyBytes: 12 },
          }),
        };
      }
      if (url.endsWith('/api/ai/conversations/conversation-1')) {
        return {
          ok: true,
          json: async () => ({ messages: [
            { role: 'user', status: 'complete', body: 'What changed?' },
            { role: 'assistant', status: 'failed', body: null, provider: 'openai', model: 'gpt-test' },
          ] }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const { context, get } = harness({ apiFetch });
    get('ai-chat-input').value = 'What changed?';

    await context.sendChatMessage();

    assert.equal(get('ai-chat-input').value, '');
    assert.equal(get('ai-conversation-select').value, 'conversation-1');
    assert.equal(get('ai-chat-messages').children[0].children[0].textContent, 'What changed?');
    assert.equal(get('ai-chat-messages').children[1].children[0].textContent, 'ai.chat.failed');
    assert.equal(get('ai-error').textContent, 'Provider request failed (400)');
    assert.equal(calls.length, 3);
  });

  it('restores the question when the request fails before server persistence', async () => {
    const { context, get } = harness({ apiFetch: async () => { throw new Error('network unavailable'); } });
    get('ai-chat-input').value = 'Can I retry this?';

    await context.sendChatMessage();

    assert.equal(get('ai-chat-input').value, 'Can I retry this?');
    assert.equal(get('ai-chat-messages').children.length, 0);
    assert.equal(get('ai-error').textContent, 'network unavailable');
  });
});
