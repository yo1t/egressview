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

const routerSettingsJs = stripEsModule(fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'router-settings.js'),
  'utf8'
));

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this._textContent = '';
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.listeners = new Map();
    this.value = '';
    this.placeholder = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.focused = false;
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
  focus() { this.focused = true; }
  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    return descendants(this).filter(element => className && element.classList.contains(className));
  }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function makeHarness() {
  const ids = new Map();
  const inputIds = [
    'router-editor', 'router-count', 'router-add-btn', 'router-list', 'router-kind',
    'router-nat-group', 'router-enable-group', 'router-display-name', 'router-edit-id',
    'router-ip', 'router-user', 'router-pass', 'router-enable-pass', 'router-nat',
    'router-enabled', 'router-editor-title', 'router-editor-status', 'router-cancel-btn',
    'router-save-btn', 'router-detect-btn',
  ];
  inputIds.forEach(id => ids.set(id, new FakeElement('div', id)));
  ids.get('router-editor').classList.add('hidden');
  const socketHandlers = new Map();
  const routerLists = [];
  const confirms = [];
  const context = {
    console,
    Date,
    Math,
    encodeURIComponent,
    _BASE: '',
    t: key => key === 'settings.routers.confirmDelete' ? 'Delete {name}?' : `<${key}>`,
    fmtTs: timestamp => `<time:${timestamp}>`,
    apiFetch: () => new Promise(() => {}),
    socket: { on: (event, handler) => socketHandlers.set(event, handler) },
    setRouterList: list => routerLists.push(list),
    confirm: message => { confirms.push(message); return false; },
    alert() {},
    document: {
      createElement: tag => new FakeElement(tag),
      getElementById: id => ids.get(id) || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(routerSettingsJs, context);
  return { context, ids, socketHandlers, routerLists, confirms };
}

describe('Router settings DOM rendering', () => {
  it('renders external router values as text with state classes', () => {
    const { ids, socketHandlers, routerLists } = makeHarness();
    socketHandlers.get('routers-status')([
      {
        id: 'yamaha"><img src=x onerror=alert(1)>', kind: 'yamaha',
        displayName: '<script>Yamaha</script>', ip: '<svg onload=alert(1)>',
        enabled: true, ready: true, sessionCount: 12, lastSuccessAt: 100,
      },
      {
        id: 'cisco-1', kind: 'cisco', displayName: 'Cisco', ip: '192.0.2.20',
        enabled: true, ready: false, state: 'connecting',
      },
    ]);

    const list = ids.get('router-list');
    assert.equal(list.children.length, 2);
    assert.match(list.textContent, /<script>Yamaha<\/script>/);
    assert.match(list.textContent, /<svg onload=alert\(1\)>/);
    assert.match(list.textContent, /12 sessions/);
    assert.match(list.textContent, /<time:100>/);
    assert.equal(list.querySelectorAll('.ready').length, 1);
    assert.equal(list.querySelectorAll('.wait').length, 1);
    assert.equal(list.querySelectorAll('.router-edit').length, 2);
    assert.equal(list.querySelectorAll('.router-delete').length, 2);
    const tags = descendants(list).map(element => element.tagName);
    assert.equal(tags.includes('SCRIPT'), false);
    assert.equal(tags.includes('IMG'), false);
    assert.equal(tags.includes('SVG'), false);
    assert.equal(ids.get('router-count').textContent, '2 / 10');
    assert.equal(routerLists.at(-1).length, 2);
  });

  it('keeps edit and delete actions wired to the rendered router', async () => {
    const { ids, socketHandlers, confirms } = makeHarness();
    const router = {
      id: 'cisco-1', kind: 'cisco', displayName: '<b>Cisco</b>', ip: '192.0.2.20',
      user: 'operator', passSet: true, enablePassSet: true, enabled: true,
    };
    socketHandlers.get('routers-status')([router]);

    await ids.get('router-list').querySelectorAll('.router-edit')[0].click();
    assert.equal(ids.get('router-edit-id').value, 'cisco-1');
    assert.equal(ids.get('router-display-name').value, '<b>Cisco</b>');
    assert.equal(ids.get('router-kind').disabled, true);
    assert.equal(ids.get('router-editor').classList.contains('hidden'), false);
    assert.equal(ids.get('router-ip').focused, true);

    await ids.get('router-list').querySelectorAll('.router-delete')[0].click();
    assert.match(confirms[0], /<b>Cisco<\/b>/);
  });

  it('renders load errors as text and uses a status visibility class', async () => {
    const { context, ids } = makeHarness();
    context.apiFetch = async () => { throw new Error('<img src=x onerror=alert(1)>'); };

    await context.loadRouters();
    assert.equal(ids.get('router-list').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(descendants(ids.get('router-list')).some(element => element.tagName === 'IMG'), false);

    context.showEditorStatus('<script>failed</script>', false);
    const status = ids.get('router-editor-status');
    assert.equal(status.textContent, '<script>failed</script>');
    assert.equal(status.classList.contains('err'), true);
    assert.equal(status.classList.contains('is-visible'), true);
  });
});
