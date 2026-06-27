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
  constructor(id = '', dataset = {}) {
    this.id = id;
    this.dataset = dataset;
    this.style = {};
    this.value = '';
    this.textContent = '';
    this._innerHTML = '';
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
  }

  set innerHTML(value) { this._innerHTML = String(value); }
  get innerHTML() { return this._innerHTML; }

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
  appendChild(child) {
    this._innerHTML += child?.innerHTML || '';
    return child;
  }
}

function makeHarness({ logs = [], apiFetch = null } = {}) {
  const ids = new Map();
  const getEl = id => {
    if (!ids.has(id)) ids.set(id, new FakeElement(id));
    return ids.get(id);
  };

  [
    'notif-log-tbody', 'notif-log-count', 'notif-log-device-filter',
    'notif-log-table', 'notif-log-search-popup', 'notif-log-search-mode',
    'notif-log-search-input', 'notif-log-search-apply',
    'notif-log-search-clear', 'notif-log-search-close',
    'notif-log-refresh-btn', 'notif-log-detail-overlay',
    'notif-log-detail-close', 'notif-log-detail-body',
    'data-fetching-notif',
  ].forEach(getEl);

  getEl('notif-log-detail-overlay').classList.add('hidden');

  const documentListeners = {};
  const context = {
    console,
    Date,
    RegExp,
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
      createElement: tag => new FakeElement(tag),
      createDocumentFragment: () => new FakeElement('fragment'),
      addEventListener(type, fn) { documentListeners[type] = fn; },
    },
    updateSideHighlight() {},
    t: key => key,
    tVars: (_key, vars) => String(vars.n ?? vars.value ?? ''),
    esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c])),
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

    assert.match(h.getEl('notif-log-tbody').innerHTML, /example\.test/);
    assert.match(h.getEl('notif-log-tbody').innerHTML, /sample-threat/);
    assert.equal(h.getEl('notif-log-count').textContent, '1');
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
