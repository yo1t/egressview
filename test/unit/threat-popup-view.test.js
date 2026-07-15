'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function stripEsModule(source) {
  return source
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

const threatPopupJs = stripEsModule(fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'threat-popup.js'),
  'utf8'
));

class FakeElement {
  constructor(tagName = 'div', register = null) {
    this.tagName = tagName.toUpperCase();
    this._register = register;
    this._id = '';
    this._textContent = '';
    this._classes = new Set();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.parentNode = null;
    this.placeholder = '';
    this.value = '';
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
    };
  }

  set id(value) {
    this._id = String(value || '');
    if (this._id) this._register?.(this._id, this);
  }
  get id() { return this._id; }
  set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }

  addEventListener(type, listener) { this.listeners[type] = listener; }
  click() { return this.listeners.click?.({ target: this }); }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      [...child.children].forEach(node => this.appendChild(node));
      child.children = [];
      return child;
    }
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._textContent = '';
    children.forEach(child => this.appendChild(child));
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function makeHarness({ existingNote = '<b>existing note</b>' } = {}) {
  const ids = new Map();
  const register = (id, element) => ids.set(id, element);
  const createElement = tag => new FakeElement(tag, register);
  const body = createElement('div');
  body.id = 'threat-detail-body';
  const overlay = createElement('div');
  overlay.id = 'threat-detail-overlay';
  overlay.classList.add('hidden');
  const closeButton = createElement('button');
  closeButton.id = 'threat-detail-close';
  const calls = [];

  const context = {
    console,
    Date,
    JSON,
    currentLang: 'en',
    _BASE: '',
    t: key => key,
    lookupNote: () => existingNote,
    apiFetch: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ draft: '<img src=x onerror=alert(1)>' }) };
    },
    document: {
      createElement,
      createDocumentFragment: () => createElement('#fragment'),
      getElementById: id => ids.get(id) || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(threatPopupJs, context);
  return { body, calls, context, ids, overlay };
}

function threatFixture() {
  return {
    src: '<img src=x onerror=alert(1)>',
    srcLabel: '<script>source-label</script>',
    srcMac: 'aa:bb:cc:dd:ee:ff',
    srcVendor: '<b>vendor</b>',
    dst: '198.51.100.20',
    dstHost: '<svg onload=alert(1)>',
    dport: 443,
    proto: 'TCP',
    ttl: 42,
    country: 'JP',
    city: '<i>Tokyo</i>',
    org: '<a href=x>Example Org</a>',
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_000_100_000,
    threat: {
      confidence: 'high',
      source: '<script>feed</script>',
      tag: '<img src=x>',
      matchType: 'ip',
      matchValue: '<b>198.51.100.20</b>',
      url: 'https://example.test/<script>alert(1)</script>',
    },
  };
}

describe('Threat detail popup DOM rendering', () => {
  it('renders feed, connection, and note values as DOM text', () => {
    const harness = makeHarness();
    harness.context.showThreatDetail({ dataset: { threat: JSON.stringify(threatFixture()) } });

    assert.match(harness.body.textContent, /<script>feed<\/script>/);
    assert.match(harness.body.textContent, /<svg onload=alert\(1\)>/);
    assert.match(harness.body.textContent, /<a href=x>Example Org<\/a>/);
    assert.equal(harness.ids.get('threat-detail-note').value, '<b>existing note</b>');
    assert.equal(harness.overlay.classList.contains('hidden'), false);

    const tags = descendants(harness.body).map(element => element.tagName);
    assert.equal(tags.includes('SCRIPT'), false);
    assert.equal(tags.includes('IMG'), false);
    assert.equal(tags.includes('SVG'), false);
    assert.equal(tags.filter(tag => tag === 'TABLE').length, 4);
  });

  it('keeps investigate and save actions wired after DOM replacement', async () => {
    const harness = makeHarness({ existingNote: '' });
    harness.context.showThreatDetail({ dataset: { threat: JSON.stringify(threatFixture()) } });

    await harness.ids.get('threat-detail-investigate-btn').click();
    assert.equal(harness.ids.get('threat-detail-note').value, '<img src=x onerror=alert(1)>');
    assert.equal(harness.ids.get('threat-detail-status').textContent, 'note.investigate.done');

    harness.ids.get('threat-detail-note').value = '<b>saved literally</b>';
    await harness.ids.get('threat-detail-save-btn').click();
    assert.equal(harness.ids.get('threat-detail-status').textContent, 'settings.status.saved');
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[0].url, '/api/notes/draft');
    assert.equal(harness.calls[1].url, '/api/notes');
    assert.equal(JSON.parse(harness.calls[1].options.body).note, '<b>saved literally</b>');
  });
});
