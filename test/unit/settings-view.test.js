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
const settingsJs = stripEsModule(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'settings.js'), 'utf8'));
const modalJs = settingsJs.slice(0, settingsJs.indexOf('// Checkbox toggles'));

class FakeElement {
  constructor(id = '', dataset = {}) {
    this.id = id;
    this.dataset = dataset;
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

  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.listeners.click?.({ target: this }); }
  dispatch(type, event = {}) { this.listeners[type]?.({ target: this, ...event }); }
}

function makeHarness() {
  const ids = new Map();
  const getEl = id => {
    if (!ids.has(id)) ids.set(id, new FakeElement(id));
    return ids.get(id);
  };

  const overlay = getEl('settings-overlay');
  overlay.classList.add('hidden');
  const button = getEl('settings-btn');
  button.classList.add('alert');
  getEl('settings-close');

  const tabs = ['l3l4', 'general'].map(name => new FakeElement(`tab-${name}`, { tab: name }));
  const panes = ['l3l4', 'general'].map(name => getEl(`pane-${name}`));
  tabs[0].classList.add('active');
  panes[0].classList.add('active');

  const context = {
    document: {
      getElementById: getEl,
      querySelectorAll(selector) {
        if (selector === '.settings-tab') return tabs;
        if (selector === '.settings-pane') return panes;
        return [];
      },
      querySelector(selector) {
        const m = selector.match(/^\.settings-tab\[data-tab="(.+)"\]$/);
        if (!m) return null;
        return tabs.find(tab => tab.dataset.tab === m[1]) || null;
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(modalJs, context, { filename: 'public/js/settings.js' });
  return { context, getEl, overlay, button, tabs, panes };
}

describe('Settings modal view behavior', () => {
  it('normal settings button clicks open the modal without clearing the active tab', () => {
    const h = makeHarness();

    h.button.click();

    assert.equal(h.overlay.classList.contains('hidden'), false);
    assert.equal(h.button.classList.contains('alert'), false);
    assert.equal(h.tabs[0].classList.contains('active'), true);
    assert.equal(h.panes[0].classList.contains('active'), true);
    assert.equal(h.tabs[1].classList.contains('active'), false);
    assert.equal(h.panes[1].classList.contains('active'), false);
  });

  it('openSettings can still select a requested tab explicitly', () => {
    const h = makeHarness();

    h.context.openSettings('general');

    assert.equal(h.tabs[0].classList.contains('active'), false);
    assert.equal(h.panes[0].classList.contains('active'), false);
    assert.equal(h.tabs[1].classList.contains('active'), true);
    assert.equal(h.panes[1].classList.contains('active'), true);
  });
});
