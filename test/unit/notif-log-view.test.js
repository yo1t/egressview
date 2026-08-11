'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Strip ES module import/export lines so the file can run in a VM classic-script context.
// export function/class/const/let/var declarations keep their body; only the 'export' keyword is removed.
function stripEsModule(src) {
  return src
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}
const notifLogJs = stripEsModule(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'notif-log.js'), 'utf8'));

class FakeElement {
  constructor(id = '', dataset = {}, tagName = 'div', register = null) {
    this._id = '';
    this._register = register;
    this.tagName = tagName.toUpperCase();
    this.dataset = dataset;
    this.style = {};
    this.value = '';
    this._textContent = '';
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(n => this._classes.add(n)),
      remove: (...names) => names.forEach(n => this._classes.delete(n)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this._classes.has(name) : !!force;
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
    this.id = id;
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
  get innerHTML() { return this.textContent; }

  addEventListener(type, fn) { this.listeners[type] = fn; }
  dispatch(type, event = {}) {
    this.listeners[type]?.({
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    });
  }
  click() { this.dispatch('click'); }
  contains(el) { return el === this; }
  focus() {}
  getBoundingClientRect() { return { bottom: 10, left: 10 }; }
  querySelector() { return this._sortIcon || null; }
  querySelectorAll() { return []; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
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
  replaceChildren(...children) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    this._textContent = '';
    children.forEach(child => this.appendChild(child));
  }
}

function makeHarness({ logs = [], apiFetch = null } = {}) {
  const ids = new Map();
  const register = (id, el) => ids.set(id, el);
  const ensureEl = id => {
    if (!ids.has(id)) ids.set(id, new FakeElement(id, {}, 'div', register));
    return ids.get(id);
  };
  const getEl = id => ids.get(id) || null;

  [
    'notif-log-tbody', 'notif-log-count', 'notif-log-device-filter',
    'notif-log-table', 'notif-log-search-popup', 'notif-log-search-mode',
    'notif-log-search-input', 'notif-log-search-apply',
    'notif-log-search-clear', 'notif-log-search-close',
    'notif-log-refresh-btn', 'notif-log-detail-overlay',
    'notif-log-detail-close', 'notif-log-detail-body',
    'data-fetching-notif',
  ].forEach(ensureEl);

  getEl('notif-log-detail-overlay').classList.add('hidden');

  const documentListeners = {};
  const context = {
    console,
    Date,
    RegExp,
    URLSearchParams,
    localStorage: { getItem: () => '' },
    BASE_URL: '',
    _BASE: '',
    currentLang: 'en',
    nlMode: true,
    selectedIp: null,
    selectedMac: null,
    window: { innerWidth: 1024, scrollY: 0 },
    document: {
      getElementById: getEl,
      createElement: tag => new FakeElement('', {}, tag, register),
      createDocumentFragment: () => new FakeElement('', {}, '#fragment', register),
      addEventListener(type, fn) { documentListeners[type] = fn; },
    },
    updateSideHighlight() {},
    t: key => key,
    tVars: (_key, vars) => String(vars.n ?? vars.value ?? ''),
    appendDisplayScope: params => params,
    apiFetch: apiFetch || (async () => ({ ok: true, json: async () => ({ logs }) })),
  };

  vm.createContext(context);
  vm.runInContext(notifLogJs, context, { filename: 'public/js/notif-log.js' });

  return { context, getEl, documentListeners };
}

describe('Notification log detail popup', () => {
  it('loads and renders rows when the notification tab is active', async () => {
    const h = makeHarness({
      logs: [{
        type: 'threat',
        detectedAt: 1760000000000,
        src: '192.0.2.10',
        dst: '198.51.100.20',
        dstHost: 'example.test',
        dport: 443,
        proto: 'TCP',
        threatTag: 'sample-threat',
        org: 'Example Org',
      }],
    });

    await h.context.loadNotifLog();

    const tbody = h.getEl('notif-log-tbody');
    assert.match(tbody.textContent, /example\.test/);
    assert.match(tbody.textContent, /sample-threat/);
    assert.equal(tbody.children.length, 1);
    assert.equal(tbody.children[0].children.length, 7);
    assert.equal(h.getEl('notif-log-count').textContent, '1');
  });

  it('keeps HTML-like notification values as text nodes', async () => {
    const h = makeHarness({
      logs: [{
        type: 'threat',
        src: '<img src=x onerror=alert(1)>',
        dst: '198.51.100.20',
        threatTag: '<script>unsafe()</script>',
      }],
    });

    await h.context.loadNotifLog();

    const row = h.getEl('notif-log-tbody').children[0];
    assert.equal(row.children.length, 7);
    assert.match(row.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(row.textContent, /<script>unsafe\(\)<\/script>/);
    assert.deepEqual(row.children.map(cell => cell.tagName), Array(7).fill('TD'));
  });

  it('closes from the top-right close button after a row detail is opened', () => {
    const h = makeHarness();

    h.context.nlShowDetail({
      type: 'threat',
      detectedAt: 1760000000000,
      src: '192.0.2.10',
      dst: '198.51.100.20',
      threatTag: 'sample',
    });
    assert.equal(h.getEl('notif-log-detail-overlay').classList.contains('hidden'), false);
    assert.equal(h.getEl('notif-log-detail-body').children[0].tagName, 'TABLE');

    h.getEl('notif-log-detail-close').click();
    assert.equal(h.getEl('notif-log-detail-overlay').classList.contains('hidden'), true);
  });

  it('closes from the backdrop and Escape key', () => {
    const h = makeHarness();
    const overlay = h.getEl('notif-log-detail-overlay');

    h.context.nlShowDetail({ type: 'new_device', detectedAt: 1760000000000, src: '192.0.2.10' });
    overlay.dispatch('click', { target: overlay });
    assert.equal(overlay.classList.contains('hidden'), true);

    h.context.nlShowDetail({ type: 'threat', detectedAt: 1760000000000, src: '192.0.2.10' });
    h.documentListeners.keydown({ key: 'Escape' });
    assert.equal(overlay.classList.contains('hidden'), true);
  });
});
