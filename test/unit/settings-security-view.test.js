// P2-61 security settings view logic.
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const securityJs = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'settings-security.js'),
  'utf8'
).replace(/^import\s[^;]+;?\s*$/gm, '').replace(/^export\s+function\s/gm, 'function ');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this.dataset = {};
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.placeholder = '';
    this.disabled = false;
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type) {
    return Promise.all((this.listeners.get(type) || []).map(handler => handler()));
  }

  replaceChildren() {}
  createElement() { return new FakeElement(); }
}

function makeHarness({ oidc = {}, warnings = [] } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const localCopy = new FakeElement('p');
  localCopy.dataset.i18n = 'settings.security.local';

  const posts = [];
  const context = {
    console,
    encodeURIComponent,
    _BASE: '',
    t: key => `<${key}>`,
    tVars: (key, vars) => `<${key}:${JSON.stringify(vars)}>`,
    fmtTs: value => `<time:${value}>`,
    apiFetch: async (url, options = {}) => {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ success: true, warnings: [] }) };
      }
      if (url.includes('audit-events')) return { ok: true, json: async () => ({ events: [] }) };
      return { ok: true, json: async () => ({ oidc, warnings }) };
    },
    document: {
      createElement: tag => new FakeElement(tag),
      getElementById: element,
      querySelector: selector =>
        selector.includes('data-i18n') ? localCopy : new FakeElement(),
    },
  };
  vm.createContext(context);
  vm.runInContext(securityJs, context, { filename: 'settings-security.js' });
  Object.assign(context, context.initSecuritySettings(() => {}));
  return { context, element, localCopy, posts };
}

describe('settings security view: local administrator wording', () => {
  it('drops the emergency framing while OIDC is disabled', async () => {
    const harness = makeHarness({ oidc: { enabled: false }, warnings: [] });
    await harness.context.loadSecurityConfig();
    assert.equal(harness.localCopy.dataset.i18n, 'settings.security.localOnly');
    assert.equal(harness.localCopy.textContent, '<settings.security.localOnly>');
  });

  it('uses the emergency framing once OIDC is enabled', async () => {
    const harness = makeHarness({
      oidc: { enabled: true, allowedEmails: ['person@example.com'] },
      warnings: [],
    });
    await harness.context.loadSecurityConfig();
    assert.equal(harness.localCopy.dataset.i18n, 'settings.security.local');
    assert.equal(harness.localCopy.textContent, '<settings.security.local>');
  });

  it('keeps data-i18n in sync so a language switch re-renders the same variant', async () => {
    const harness = makeHarness({ oidc: { enabled: false }, warnings: [] });
    await harness.context.loadSecurityConfig();
    assert.equal(harness.localCopy.dataset.i18n, 'settings.security.localOnly');
  });
});

describe('settings security view: role-safe OIDC save', () => {
  async function save(harness, { enabled, domains }) {
    harness.element('s-oidc-enabled').checked = enabled;
    harness.element('s-oidc-domains').value = domains;
    harness.element('s-oidc-client-id').value = 'client-id';
    harness.element('s-oidc-client-secret').value = '';
    harness.element('s-oidc-emails').value = '';
    await harness.element('oidc-save-btn').dispatch('click');
  }

  it('saves a domain allowlist without the retired full-admin confirmation', async () => {
    const harness = makeHarness();
    await save(harness, { enabled: true, domains: 'example.com, corp.example.jp' });
    assert.equal(harness.posts.length, 1);
    assert.deepEqual(harness.posts[0].allowedDomains, ['example.com', 'corp.example.jp']);
  });

  it('saves an email-only allowlist', async () => {
    const harness = makeHarness();
    await save(harness, { enabled: true, domains: '' });
    assert.equal(harness.posts.length, 1);
  });

  it('saves domains while OIDC stays disabled', async () => {
    const harness = makeHarness();
    await save(harness, { enabled: false, domains: 'example.com' });
    assert.equal(harness.posts.length, 1);
  });
});
