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
}

function harness() {
  const ids = new Map();
  const cards = new Map();
  const get = id => {
    if (!ids.has(id)) ids.set(id, new FakeElement());
    return ids.get(id);
  };
  const context = {
    Intl, URLSearchParams, Date, currentLang: 'en',
    t: key => key,
    tVars: (key, values) => `${key}:${JSON.stringify(values)}`,
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
      current: { requests: 3, pricedRequests: 2, inputTokens: 1200, outputTokens: 300, totalTokens: 1500, estimatedCostUsd: 0.0084 },
      previous: { requests: 1, pricedRequests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0004 },
    });
    assert.equal(get('ai-usage-current-tokens').textContent, 'ai.usage.tokens:{"tokens":"1,500"}');
    assert.equal(get('ai-usage-current-detail').textContent, 'ai.usage.detail:{"input":"1,200","output":"300"}');
    assert.equal(get('ai-usage-current-cost').textContent, 'ai.usage.cost:{"cost":"$0.0084"}');
    assert.equal(get('ai-usage-caveat').textContent, 'ai.usage.partial');
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
});
