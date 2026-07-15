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

const beaconJs = stripEsModule(fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'beacon.js'),
  'utf8'
));

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this._textContent = '';
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.title = '';
    this.listeners = new Map();
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (enabled) this._classes.add(name);
        else this._classes.delete(name);
        return enabled;
      },
    };
  }

  set className(value) { this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
  }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }

  appendChild(child) {
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
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  async click() {
    await Promise.all((this.listeners.get('click') || []).map(listener => listener({ currentTarget: this })));
  }
  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    return descendants(this).filter(element => className && element.classList.contains(className));
  }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function makeHarness(apiResponse = { beacons: [] }) {
  const ids = new Map();
  for (const id of [
    'beacon-banner', 'beacon-banner-label', 'beacon-banner-chevron',
    'beacon-list', 'beacon-banner-bar',
  ]) {
    ids.set(id, new FakeElement('div'));
  }
  const apiCalls = [];
  const context = {
    console,
    Date,
    Number,
    Math,
    _BASE: '',
    allConnections: [],
    t: key => `<${key}>`,
    tVars: (key, vars) => `<${key}:${Object.values(vars).join(',')}>`,
    fmtTs: timestamp => `<time:${timestamp}>`,
    apiFetch: async (url, options = {}) => {
      apiCalls.push({ url, options });
      return { json: async () => apiResponse };
    },
    document: {
      createElement: tag => new FakeElement(tag),
      createTextNode: text => {
        const node = new FakeElement('#text');
        node.textContent = text;
        return node;
      },
      getElementById: id => ids.get(id) || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(beaconJs, context);
  return { context, ids, apiCalls };
}

describe('Beacon view DOM rendering', () => {
  it('renders external and translated values as text', () => {
    const { context, ids } = makeHarness();
    context.allConnections.push({
      src: '192.0.2.10',
      srcMdnsName: '<img src=x onerror=alert(1)>.local',
    });
    context.beaconData = [{
      id: '7"><svg onload=alert(1)>',
      src: '192.0.2.10',
      dst: '198.51.100.20',
      dstHost: '<script>alert(1)</script>',
      intervalMs: 60_000,
      intervalCov: 0.08,
      obsCount: '<b>12</b>',
      firstSeen: 100,
      lastSeen: 200,
    }];

    context.renderBeaconList(ids.get('beacon-list'));

    const list = ids.get('beacon-list');
    assert.match(list.textContent, /<img src=x onerror=alert\(1\)> \(192\.0\.2\.10\)/);
    assert.match(list.textContent, /<script>alert\(1\)<\/script>/);
    assert.match(list.textContent, /198\.51\.100\.20/);
    assert.match(list.textContent, /<b>12<\/b>/);
    assert.match(list.textContent, /<beacon\.col\.src>/);

    const tags = descendants(list).map(element => element.tagName);
    assert.equal(tags.includes('SCRIPT'), false);
    assert.equal(tags.includes('IMG'), false);
    assert.equal(tags.includes('SVG'), false);
    assert.equal(list.querySelectorAll('.beacon-dismiss-btn').length, 1);
    assert.equal(list.querySelectorAll('.beacon-cov-low').length, 1);
  });

  it('opens the list and keeps the dismiss API action wired', async () => {
    const { context, ids, apiCalls } = makeHarness();
    context.beaconData = [{
      id: 42, src: '192.0.2.10', dst: '198.51.100.20', intervalMs: 120_000,
      intervalCov: 0.2, obsCount: 5, firstSeen: 100, lastSeen: 200,
    }];
    context.renderBeaconBanner();
    await ids.get('beacon-banner-bar').click();

    assert.equal(ids.get('beacon-list').classList.contains('is-visible'), true);
    const button = ids.get('beacon-list').querySelectorAll('.beacon-dismiss-btn')[0];
    await button.click();

    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].url, '/api/beacons/42/dismiss');
    assert.equal(apiCalls[0].options.method, 'POST');
    assert.equal(ids.get('beacon-banner').classList.contains('is-visible'), false);
  });

  it('loads active candidates and filters dismissed records', async () => {
    const { context, ids, apiCalls } = makeHarness({
      beacons: [
        { id: 1, status: 'active' },
        { id: 2, status: 'dismissed' },
      ],
    });

    await context.loadBeacons();

    assert.equal(apiCalls[0].url, '/api/beacons');
    assert.equal(ids.get('beacon-banner').classList.contains('is-visible'), true);
    assert.equal(ids.get('beacon-banner-label').textContent, '<beacon.banner:1>');
  });
});
