'use strict';

// The settings pane must show which feeds answered (P3-54).
//
// `#threat-feed-status` existed in index.html since the pane was written and
// nothing ever filled it. On 2026-08-29 the Hub matched with Feodo absent and
// the pane showed nothing at all, which is the same defect as the log line
// that said `Ready: 6998 IPs` -- a screen that cannot say what is missing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(
  path.join(root, 'public', 'js', 'settings-threat-feeds.js'), 'utf8'
)
  .replace(/^import\s[^;]+;?\s*$/gm, '')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';?\s*$/gm, '')
  .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.textContent = '';
    this.className = '';
    this.children = [];
    this.attributes = {};
  }
  append(...kids) { this.children.push(...kids); }
  appendChild(kid) { this.children.push(kid); return kid; }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get text() {
    return [this.textContent, ...this.children.map(c => c.text)].filter(Boolean).join(' ');
  }
}

function harness() {
  const container = new FakeElement();
  const context = {
    Date, Number, Array, Object, JSON,
    t: key => key,
    tVars: (key, values) => `${key}:${JSON.stringify(values)}`,
    _BASE: '',
    apiFetch: async () => { throw new Error('not used'); },
    document: {
      getElementById: id => (id === 'threat-feed-status' ? container : null),
      createElement: tag => new FakeElement(tag),
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings-threat-feeds.js' });
  return { context, container };
}

describe('脅威フィードの状態を設定画面に出す (P3-54)', () => {
  it('取得できた・キャッシュ・何もない を3通りに分ける', () => {
    const { context } = harness();
    assert.equal(context.classify({ entries: 5, lastSuccessAt: 1, restoredAt: null }).kind, 'fresh');
    // Matching, but on entries this process never fetched. Not "fine".
    assert.equal(context.classify({ entries: 5, lastSuccessAt: null, restoredAt: 1 }).kind, 'cached');
    assert.equal(context.classify({ entries: 0, lastSuccessAt: null, restoredAt: null }).kind, 'absent');
  });

  it('欠けているフィードを名前と理由つきで出す', () => {
    const { context, container } = harness();
    context.renderThreatFeedStatus({
      feeds: [
        { name: 'feodo', entries: 0, lastSuccessAt: null, restoredAt: null, lastError: '503' },
        { name: 'urlhaus', entries: 5331, lastSuccessAt: 2, restoredAt: null, lastError: null },
      ],
    });
    const rendered = container.children.map(c => `${c.className} ${c.text}`).join('\n');
    assert.match(rendered, /Feodo Tracker/);
    assert.match(rendered, /threat-feed-absent/);
    assert.match(rendered, /503/, 'the feed\'s own error text is shown');
    assert.match(rendered, /threat-feed-fresh/);
    // The heading says the consequence, not just a count.
    assert.match(rendered, /feedSomeMissing/);
  });

  it('全部取得できていれば、欠落を主張しない', () => {
    const { context, container } = harness();
    context.renderThreatFeedStatus({
      feeds: [{ name: 'urlhaus', entries: 1, lastSuccessAt: 2, restoredAt: null, lastError: null }],
    });
    const rendered = container.children.map(c => `${c.className} ${c.text}`).join('\n');
    assert.match(rendered, /feedAllFresh/);
    assert.doesNotMatch(rendered, /feedSomeMissing/);
  });

  it('一度も取得していない状態を、空欄にしない', () => {
    // Different from "all four answered and found nothing". An empty pane is
    // exactly what this replaces.
    const { context, container } = harness();
    context.renderThreatFeedStatus(null);
    assert.equal(container.children.length, 1);
    assert.match(container.children[0].text, /feedNoneYet/);
  });

  it('キャッシュ由来を、取得できたものと同じ見た目にしない', () => {
    const { context, container } = harness();
    context.renderThreatFeedStatus({
      feeds: [{ name: 'spamhaus', entries: 1705, lastSuccessAt: null, restoredAt: 9, lastError: null }],
    });
    const rendered = container.children.map(c => `${c.className} ${c.text}`).join('\n');
    assert.match(rendered, /threat-feed-cached/);
    assert.doesNotMatch(rendered, /threat-feed-fresh/);
    // And the heading counts it as not fetched.
    assert.match(rendered, /feedSomeMissing/);
  });
});
