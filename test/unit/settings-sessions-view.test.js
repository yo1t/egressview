'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsJs = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'settings.js'),
  'utf8'
);
const sectionStart = settingsJs.indexOf('// ── Login sessions list');
const sectionEnd = settingsJs.indexOf("document.getElementById('sessions-revoke-all-btn')", sectionStart);
const sessionsJs = settingsJs.slice(sectionStart, sectionEnd);

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this._textContent = '';
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.listeners = new Map();
    this.type = '';
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
    return descendants(this).filter(element => className && element._classes.has(className));
  }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function makeHarness(responses = []) {
  const box = new FakeElement('div');
  const calls = [];
  const queue = [...responses];
  const context = {
    console,
    encodeURIComponent,
    _BASE: '',
    t: key => `<${key}>`,
    fmtTs: timestamp => `<time:${timestamp}>`,
    apiFetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'POST') return { ok: true, json: async () => ({ success: true }) };
      const response = queue.shift() || { sessions: [] };
      return { ok: true, json: async () => response };
    },
    document: {
      createElement: tag => new FakeElement(tag),
      getElementById: id => id === 'sessions-list' ? box : null,
    },
  };
  vm.createContext(context);
  vm.runInContext(sessionsJs, context, { filename: 'settings-sessions.js' });
  return { context, box, calls };
}

describe('Settings login sessions DOM rendering', () => {
  it('renders current and revocable session values as text', async () => {
    const { context, box } = makeHarness([{ sessions: [
      {
        id: 'current', deviceLabel: '<script>Current</script>', current: true,
        lastSeenAt: '<img src=x onerror=alert(1)>',
      },
      {
        id: '../other?id=1', deviceLabel: '<svg onload=alert(1)>', current: false,
        lastSeenAt: 200,
      },
    ] }]);

    await context.loadSessionsList();

    assert.equal(box.children.length, 2);
    assert.match(box.textContent, /<script>Current<\/script>/);
    assert.match(box.textContent, /<svg onload=alert\(1\)>/);
    assert.match(box.textContent, /<time:<img src=x onerror=alert\(1\)>>/);
    assert.match(box.textContent, /<settings\.sessions\.current>/);
    assert.equal(box.querySelectorAll('.settings-session-current').length, 1);
    assert.equal(box.querySelectorAll('.settings-session-revoke').length, 1);
    const tags = descendants(box).map(element => element.tagName);
    assert.equal(tags.includes('SCRIPT'), false);
    assert.equal(tags.includes('IMG'), false);
    assert.equal(tags.includes('SVG'), false);
  });

  it('encodes the session id, revokes it, and refreshes the list', async () => {
    const { context, box, calls } = makeHarness([
      { sessions: [{ id: '../other?id=1', deviceLabel: 'Other', current: false, lastSeenAt: 200 }] },
      { sessions: [] },
    ]);
    await context.loadSessionsList();
    await box.querySelectorAll('.settings-session-revoke')[0].click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls[1].url, '/api/auth/sessions/..%2Fother%3Fid%3D1/revoke');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[2].url, '/api/auth/sessions');
    assert.equal(box.textContent, '<settings.sessions.none>');
  });

  it('renders fetch errors as text', async () => {
    const { context, box } = makeHarness();
    context.apiFetch = async () => { throw new Error('<img src=x onerror=alert(1)>'); };

    await context.loadSessionsList();

    assert.equal(box.textContent, 'Error: <img src=x onerror=alert(1)>');
    assert.equal(descendants(box).some(element => element.tagName === 'IMG'), false);
  });
});
