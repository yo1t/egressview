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
const logJs = stripEsModule(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'log.js'), 'utf8'));

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

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
  get className() { return [...this._classes].join(' '); }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('');
  }

  get innerHTML() { return this.textContent; }

  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.listeners.click?.({ target: this, stopPropagation() {} }); }
  dispatch(type, event = {}) { this.listeners[type]?.({ target: this, stopPropagation() {}, ...event }); }
  contains() { return false; }
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

function makeHarness({ rows = [], apiFetch = null, timeRange = { from: null, to: null }, sourceScope = null } = {}) {
  const ids = new Map();
  const register = (id, el) => ids.set(id, el);
  const ensureEl = id => {
    if (!ids.has(id)) ids.set(id, new FakeElement(id, {}, 'div', register));
    return ids.get(id);
  };
  const getEl = id => ids.get(id) || null;

  [
    'log-pagination', 'log-tbody', 'log-count', 'log-threat-count',
    'log-device-filter', 'log-search-popup', 'log-search-input',
    'log-search-mode', 'log-search-date-range', 'log-search-popup-title',
    'log-search-from', 'log-search-to', 'log-search-apply',
    'log-search-clear', 'log-search-close', 'log-export-btn', 'log-export-format',
  ].forEach(ensureEl);

  ensureEl('log-search-mode').value = 'contains';
  ensureEl('log-export-format').value = 'csv';

  const headers = ['lastSeen', 'dst', 'app', 'threatTag'].map(col => {
    const th = new FakeElement(`th-${col}`, { col }, 'th', register);
    th._sortIcon = new FakeElement(`sort-${col}`);
    return th;
  });
  const searchIcons = ['dst', 'app', 'threatTag'].map(col => {
    const el = new FakeElement(`search-${col}`, { col }, 'span', register);
    el.classList.add('log-search-icon');
    return el;
  });

  const urls = [];
  const context = {
    console,
    URLSearchParams,
    Date,
    RegExp,
    window: { innerWidth: 1024 },
    document: {
      getElementById: getEl,
      createElement: tagName => new FakeElement('', {}, tagName, register),
      createDocumentFragment: () => new FakeElement('', {}, '#fragment', register),
      querySelectorAll(selector) {
        if (selector === '#log-table th[data-col]') return headers;
        if (selector === '#log-table th') return headers;
        if (selector === '.log-search-icon') return searchIcons;
        return [];
      },
      querySelector(selector) {
        const m = selector.match(/^\.log-search-icon\[data-col="(.+)"\]$/);
        if (m) return searchIcons.find(el => el.dataset.col === m[1]) || null;
        return null;
      },
      addEventListener() {},
    },
    logMode: true,
    _BASE: '',
    currentLang: 'en',
    selectedIp: null,
    selectedMac: null,
    serverTimeOffset: 0,
    appendDisplayScope(params) {
      if (sourceScope) {
        params.set('sourceKind', sourceScope.sourceKind);
        params.set('sourceId', sourceScope.sourceId);
      }
      return params;
    },
    setServerTimeOffset() {},
    getTimeRange: () => timeRange,
    apiFetch: apiFetch || (async url => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({ connections: rows, total: rows.length, serverTime: Date.now() }),
      };
    }),
    setFetching() {},
    updateSideHighlight() {},
    clearSelection() { context.selectedMac = null; context.selectedIp = null; },
    showToast() {},
    t: key => key,
    tVars: (_key, vars) => vars.value || '',
    guessApp: (dport, proto, host) => {
      if (Number(dport) === 443 && String(proto).toUpperCase() === 'TCP') return 'HTTPS';
      if (Number(dport) === 53) return 'DNS';
      return host || 'Unknown';
    },
    showThreatDetail() {},
  };

  vm.createContext(context);
  vm.runInContext(logJs, context, { filename: 'public/js/log.js' });

  const settle = () => new Promise(resolve => setImmediate(resolve));
  const lastUrl = () => urls[urls.length - 1] || '';
  const lastParams = () => new URL(lastUrl(), 'http://local').searchParams;
  // Returns params from the most recent /connections (non-threat-counts) request
  const lastConnectionsUrl = () =>
    [...urls].reverse().find(u => !u.includes('/threat-counts')) || '';
  const lastConnectionsParams = () => new URL(lastConnectionsUrl(), 'http://local').searchParams;
  return { context, getEl, headers, searchIcons, urls, lastUrl, lastParams, lastConnectionsParams, settle };
}

describe('Connection Log view behavior', () => {
  it('builds an authenticated export URL from the selected period without credentials', () => {
    const h = makeHarness({ timeRange: { from: 1000, to: 2000 } });
    const url = h.context.buildConnectionExportUrl('json');
    const parsed = new URL(url, 'http://local');
    assert.equal(parsed.pathname, '/api/connections/export');
    assert.equal(parsed.searchParams.get('format'), 'json');
    assert.equal(parsed.searchParams.get('from'), '1000');
    assert.equal(parsed.searchParams.get('to'), '2000');
    assert.equal(parsed.searchParams.has('token'), false);
  });

  it('rejects export when the selected period has no lower bound', () => {
    const h = makeHarness();
    assert.throws(() => h.context.buildConnectionExportUrl('csv'), /log\.export\.period-required/);
  });

  it('adds the selected collection source to history and export requests', async () => {
    const h = makeHarness({
      timeRange: { from: 1000, to: 2000 },
      sourceScope: { sourceKind: 'agent', sourceId: 'agent-1' },
    });
    const exported = new URL(h.context.buildConnectionExportUrl('csv'), 'http://local');
    assert.equal(exported.searchParams.get('sourceKind'), 'agent');
    assert.equal(exported.searchParams.get('sourceId'), 'agent-1');

    h.context.updateLogView();
    await h.settle();
    assert.equal(h.lastConnectionsParams().get('sourceKind'), 'agent');
    assert.equal(h.lastConnectionsParams().get('sourceId'), 'agent-1');
  });

  it('uses paged API calls by default', async () => {
    const h = makeHarness();
    h.context.updateLogView();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.get('limit'), '200');
    assert.equal(params.get('offset'), '0');
  });

  it('renders connection values as text in a ten-cell DOM row', async () => {
    const h = makeHarness({
      rows: [{
        src: '<b>source</b>',
        dst: '<img src=x onerror=alert(1)>',
        dport: 443,
        proto: 'TCP',
        country: 'JP',
        org: '<script>unsafe()</script>',
      }],
    });
    h.context.updateLogView();
    await h.settle();

    const tbody = h.getEl('log-tbody');
    assert.equal(tbody.children.length, 1);
    assert.equal(tbody.children[0].tagName, 'TR');
    assert.equal(tbody.children[0].children.length, 10);
    assert.match(tbody.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(tbody.textContent, /<script>unsafe\(\)<\/script>/);
    assert.deepEqual(tbody.children[0].children.map(cell => cell.tagName), Array(10).fill('TD'));
  });

  it('shows multiple Agent applications without replacing them with a port guess', async () => {
    const h = makeHarness({
      rows: [{
        src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
        applicationCount: 2,
        applications: [
          {
            agentHost: 'macbook', processName: 'Google Chrome Helper',
            bundleId: 'com.google.Chrome', matchKind: 'exact-5tuple',
            bytesIn: '1536', bytesOut: '18446744073709551615',
            byteObservationCount: 1, byteCompleteness: 'complete',
          },
          {
            agentHost: 'macbook', processName: 'Slack Helper',
            bundleId: 'com.tinyspeck.slackmacgap', matchKind: 'unique-4tuple-time',
            bytesIn: '512', bytesOut: null,
            byteObservationCount: 2, byteCompleteness: 'partial',
          },
        ],
      }],
    });
    h.context.updateLogView();
    await h.settle();

    const appCell = h.getEl('log-tbody').children[0].children[4];
    assert.match(appCell.textContent, /Google Chrome Helper \+1/);
    assert.match(appCell.textContent, /log\.app\.badge\.confirmed/);
    assert.match(appCell.title, /com\.google\.Chrome/);
    assert.match(appCell.title, /com\.tinyspeck\.slackmacgap/);
    const trafficCell = h.getEl('log-tbody').children[0].children[5];
    assert.match(trafficCell.textContent, /↓ 1.5 KiB/);
    assert.match(trafficCell.textContent, /↑ 16 EiB/);
    assert.match(trafficCell.textContent, /\+1/);
    assert.match(trafficCell.title, /Google Chrome Helper/);
    assert.match(trafficCell.title, /Slack Helper/);
    assert.match(trafficCell.title, /log\.appTraffic\.partial/);
  });

  it('shows unavailable Agent byte counts as unknown rather than zero', async () => {
    const h = makeHarness({
      rows: [{
        src: '192.0.2.10', dst: '198.51.100.10', dport: 443, proto: 'TCP',
        applications: [{
          agentHost: 'macbook', processName: 'Safari', matchKind: 'agent-only',
          bytesIn: null, bytesOut: null, byteObservationCount: 1,
          byteCompleteness: 'unavailable',
        }],
      }],
    });
    h.context.updateLogView();
    await h.settle();

    const trafficCell = h.getEl('log-tbody').children[0].children[5];
    assert.equal(trafficCell.textContent, '—');
    assert.doesNotMatch(trafficCell.textContent, /0/);
  });

  it('server-side filters keep pagination and are sent as API params', async () => {
    const h = makeHarness();
    h.searchIcons.find(el => el.dataset.col === 'dst').click();
    h.getEl('log-search-input').value = 'google';
    h.getEl('log-search-mode').value = 'contains';
    h.getEl('log-search-apply').click();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.get('limit'), '200');
    assert.equal(params.get('fDst'), 'google');
    assert.equal(params.get('fDstMode'), 'contains');
  });

  it('IP-only device filters use server-side src filtering', async () => {
    const h = makeHarness();
    h.context.selectedIp = '192.168.1.10';
    h.context.selectedMac = null;
    h.context.updateLogView();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.get('limit'), '200');
    assert.equal(params.get('fSrc'), '192.168.1.10');
    assert.equal(params.get('fSrcMode'), 'exact');
  });

  it('MAC-backed device filters use server-side srcMac filtering with pagination', async () => {
    const h = makeHarness({
      rows: [
        { src: '192.168.1.10', srcMac: 'aa:bb:cc:dd:ee:ff', dst: '8.8.8.8', dport: 443, proto: 'TCP' },
        { src: '192.168.1.11', srcMac: 'aa:bb:cc:dd:ee:ff', dst: '1.1.1.1', dport: 443, proto: 'TCP' },
        { src: '192.168.1.12', srcMac: '11:22:33:44:55:66', dst: '9.9.9.9', dport: 443, proto: 'TCP' },
      ],
    });
    h.context.selectedIp = '192.168.1.10';
    h.context.selectedMac = 'aa:bb:cc:dd:ee:ff';
    h.context.updateLogView();
    await h.settle();

    const params = h.lastConnectionsParams();
    // MAC filter is now server-side: pagination params are sent
    assert.equal(params.get('limit'), '200');
    assert.equal(params.has('offset'), true);
    // fSrcMac is sent instead of fSrc
    assert.equal(params.get('fSrcMac'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(params.has('fSrc'), false);
    // Client-side guard still filters the mock response by srcMac
    assert.match(h.getEl('log-tbody').textContent, /8\.8\.8\.8/);
    assert.match(h.getEl('log-tbody').textContent, /1\.1\.1\.1/);
    assert.doesNotMatch(h.getEl('log-tbody').textContent, /9\.9\.9\.9/);
  });

  it('clearing the device filter refetches without the src filter', async () => {
    const h = makeHarness({
      rows: [{ src: '192.168.1.10', dst: '8.8.8.8', dport: 443, proto: 'TCP' }],
    });
    h.context.selectedIp = '192.168.1.10';
    h.context.selectedMac = null;
    h.context.updateLogView();
    await h.settle();
    assert.equal(h.lastConnectionsParams().get('fSrc'), '192.168.1.10');

    h.getEl('log-device-filter-clear').click();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.has('fSrc'), false);
    assert.equal(params.get('limit'), '200');
  });

  it('app filters fetch all rows so matches beyond the current page are included', async () => {
    const h = makeHarness();
    h.searchIcons.find(el => el.dataset.col === 'app').click();
    h.getEl('log-search-input').value = 'HTTPS';
    h.getEl('log-search-mode').value = 'contains';
    h.getEl('log-search-apply').click();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.has('limit'), false);
    assert.equal(params.has('offset'), false);
  });

  it('regex filters fetch all rows', async () => {
    const h = makeHarness();
    h.searchIcons.find(el => el.dataset.col === 'dst').click();
    h.getEl('log-search-input').value = '.*google.*';
    h.getEl('log-search-mode').value = 'regex';
    h.getEl('log-search-apply').click();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.has('limit'), false);
    assert.equal(params.has('offset'), false);
  });

  it('threat badge filters keep pagination and are sent as API params', async () => {
    const h = makeHarness({
      rows: [{ src: '192.168.1.2', dst: '8.8.8.8', dport: 443, proto: 'TCP', threat: null }],
    });
    h.context.updateLogView();
    await h.settle();
    h.getEl('log-filter-safe').click();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.get('limit'), '200');
    assert.equal(params.get('offset'), '0');
    assert.equal(params.get('fThreat'), 'safe');
  });

  it('client-only app sorting fetches all rows before sorting', async () => {
    const h = makeHarness();
    h.headers.find(el => el.dataset.col === 'app').click();
    await h.settle();

    const params = h.lastConnectionsParams();
    assert.equal(params.has('limit'), false);
    assert.equal(params.has('offset'), false);
  });

  it('ignores stale fetch responses when a newer log request has already completed', async () => {
    let resolveFirst;
    const firstCanResolve = new Promise(resolve => { resolveFirst = resolve; });
    const urls = [];
    let call = 0;
    const h = makeHarness({
      apiFetch: async url => {
        urls.push(String(url));
        call += 1;
        if (call === 1) {
          await firstCanResolve;
          return {
            ok: true,
            json: async () => ({
              connections: [{ src: '192.168.1.10', dst: 'old.example', dport: 443, proto: 'TCP' }],
              total: 1,
              serverTime: Date.now(),
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            connections: [{ src: '192.168.1.20', dst: 'new.example', dport: 443, proto: 'TCP' }],
            total: 1,
            serverTime: Date.now(),
          }),
        };
      },
    });

    h.context.updateLogView();
    h.context.updateLogView();
    await h.settle();
    assert.match(h.getEl('log-tbody').textContent, /new\.example/);

    resolveFirst();
    await h.settle();

    assert.match(h.getEl('log-tbody').textContent, /new\.example/);
    assert.doesNotMatch(h.getEl('log-tbody').textContent, /old\.example/);
    // 2 updateLogView calls × (1 connections + 1 threat-counts) = 4 requests total
    assert.equal(urls.length, 4);
  });
});
