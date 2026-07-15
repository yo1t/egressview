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

const connectionsPanelJs = stripEsModule(fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'connections-panel.js'),
  'utf8'
));

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this._textContent = '';
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.title = '';
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
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function makeHarness() {
  const ids = new Map();
  for (const id of [
    'data-fetching', 'data-fetching-stats', 'data-fetching-log',
    'conn-panel', 'conn-list', 'conn-panel-title', 'conn-count',
  ]) {
    ids.set(id, new FakeElement('div'));
  }
  const context = {
    console,
    Date,
    Map,
    t: key => key,
    document: {
      createElement: tag => new FakeElement(tag),
      createDocumentFragment: () => new FakeElement('#fragment'),
      getElementById: id => ids.get(id) || null,
    },
  };
  vm.createContext(context);
  vm.runInContext(connectionsPanelJs, context);
  context.setCurrentTimeFilter('custom');
  context.setCustomRangeFrom(null);
  context.setCustomRangeTo(null);
  return { context, ids };
}

describe('Connections panel DOM rendering', () => {
  it('groups destinations and keeps external values as text', () => {
    const { context, ids } = makeHarness();
    context.setAllConnections([
      {
        src: '192.0.2.10', dst: '198.51.100.20', dstHost: '<img src=x onerror=alert(1)>',
        dport: 443, proto: '<script>TCP</script>', country: 'JP',
        org: '<svg onload=alert(1)>', threat: { tag: '<b>threat title</b>' },
      },
      {
        src: '192.0.2.10', dst: '198.51.100.20', dstHost: '<img src=x onerror=alert(1)>',
        dport: 443, proto: '<script>TCP</script>', country: 'JP',
        org: '<svg onload=alert(1)>', threat: { tag: '<b>threat title</b>' },
      },
      {
        src: '192.0.2.10', dst: '203.0.113.30', dport: 80, proto: 'TCP', country: '', org: '',
      },
      {
        src: '192.0.2.10', dst: '203.0.113.31', dport: 80, proto: 'TCP', country: '', org: '',
      },
    ]);

    context.updateConnPanel('192.0.2.10');

    const panel = ids.get('conn-panel');
    const list = ids.get('conn-list');
    assert.equal(panel.classList.contains('is-visible'), true);
    assert.equal(ids.get('conn-count').textContent, '4 panel.conn.session');
    assert.equal(list.children.length, 3);
    assert.match(list.children[0].textContent, /HTTPS ×2/);
    assert.match(list.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(list.textContent, /<svg onload=alert\(1\)>/);
    assert.match(list.textContent, /203\.0\.113\.30/);
    assert.match(list.textContent, /203\.0\.113\.31/);

    const tags = descendants(list).map(element => element.tagName);
    assert.equal(tags.includes('SCRIPT'), false);
    assert.equal(tags.includes('IMG'), false);
    assert.equal(tags.includes('SVG'), false);
    const threatIcon = descendants(list).find(element => element.classList.contains('conn-threat'));
    assert.equal(threatIcon.title, '<b>threat title</b>');
  });

  it('renders the empty state and hides the panel when selection clears', () => {
    const { context, ids } = makeHarness();
    context.setAllConnections([]);

    context.updateConnPanel('192.0.2.10');
    assert.equal(ids.get('conn-list').children.length, 1);
    assert.equal(ids.get('conn-list').textContent, 'panel.conn.empty');

    context.updateConnPanel(null);
    assert.equal(ids.get('conn-panel').classList.contains('is-visible'), false);
  });

  it('uses state classes for all shared loading indicators', () => {
    const { context, ids } = makeHarness();
    context.setFetching(1);
    for (const id of ['data-fetching', 'data-fetching-stats', 'data-fetching-log']) {
      assert.equal(ids.get(id).classList.contains('is-visible'), true);
    }
    context.setFetching(-1);
    for (const id of ['data-fetching', 'data-fetching-stats', 'data-fetching-log']) {
      assert.equal(ids.get(id).classList.contains('is-visible'), false);
    }
  });
});
