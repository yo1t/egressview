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
    Intl, URLSearchParams, Date,
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

  it('renders persisted conversation messages as untrusted text', () => {
    const { context, get } = harness();
    context.renderChatMessages([
      { role: 'user', status: 'complete', body: '<img src=x onerror=alert(1)>' },
      { role: 'assistant', status: 'failed', body: null },
    ]);
    const children = get('ai-chat-messages').children;
    assert.equal(children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(children[1].textContent, 'ai.chat.failed');
    assert.equal(children[1].classList.contains('is-failed'), true);
  });
});
