// P2-61 Phase 0 view logic: the domain advisory and the local-administrator
// wording are driven only by the saved OIDC state and the field contents.
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

  const confirmCalls = [];
  const posts = [];
  const context = {
    console,
    encodeURIComponent,
    _BASE: '',
    t: key => `<${key}>`,
    tVars: (key, vars) => `<${key}:${JSON.stringify(vars)}>`,
    fmtTs: value => `<time:${value}>`,
    globalThis: { confirm: message => { confirmCalls.push(message); return context.confirmResult; } },
    confirmResult: true,
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
  return { context, element, localCopy, confirmCalls, posts };
}

describe('settings security view: domain allowlist advisory', () => {
  it('warns for domains reported by the server', async () => {
    const harness = makeHarness({
      oidc: { enabled: true, allowedDomains: ['example.com'] },
      warnings: [{ code: 'domain_allowlist_grants_admin', domains: ['example.com'] }],
    });
    await harness.context.loadSecurityConfig();
    const box = harness.element('oidc-domain-warning');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /settings\.security\.domainsActiveWarning/);
    assert.match(box.textContent, /example\.com/);
  });

  it('stays silent for an email-only allowlist', async () => {
    const harness = makeHarness({
      oidc: { enabled: true, allowedEmails: ['person@example.com'], allowedDomains: [] },
      warnings: [],
    });
    await harness.context.loadSecurityConfig();
    assert.equal(harness.element('oidc-domain-warning').hidden, true);
  });

  it('warns for saved domains even while OIDC is still disabled', async () => {
    const harness = makeHarness({
      oidc: { enabled: false, allowedDomains: ['example.com'] },
      warnings: [],
    });
    await harness.context.loadSecurityConfig();
    const box = harness.element('oidc-domain-warning');
    assert.equal(box.hidden, false, 'a stored domain is a live risk once OIDC is switched on');
    assert.match(box.textContent, /example\.com/);
  });

  it('warns while a domain is being typed, before anything is saved', async () => {
    const harness = makeHarness({ oidc: { enabled: false, allowedDomains: [] }, warnings: [] });
    await harness.context.loadSecurityConfig();
    assert.equal(harness.element('oidc-domain-warning').hidden, true);

    const field = harness.element('s-oidc-domains');
    field.value = 'typed.example';
    await field.dispatch('input');

    const box = harness.element('oidc-domain-warning');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /typed\.example/);
  });

  it('clears the advisory when the field is emptied again', async () => {
    const harness = makeHarness({ oidc: { enabled: false, allowedDomains: [] }, warnings: [] });
    await harness.context.loadSecurityConfig();
    const field = harness.element('s-oidc-domains');
    field.value = 'typed.example';
    await field.dispatch('input');
    field.value = '';
    await field.dispatch('input');
    assert.equal(harness.element('oidc-domain-warning').hidden, true);
  });
});

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

describe('settings security view: save confirmation', () => {
  async function save(harness, { enabled, domains }) {
    harness.element('s-oidc-enabled').checked = enabled;
    harness.element('s-oidc-domains').value = domains;
    harness.element('s-oidc-client-id').value = 'client-id';
    harness.element('s-oidc-client-secret').value = '';
    harness.element('s-oidc-emails').value = '';
    await harness.element('oidc-save-btn').dispatch('click');
  }

  it('re-states the consequence before enabling a domain allowlist', async () => {
    const harness = makeHarness();
    await save(harness, { enabled: true, domains: 'example.com, corp.example.jp' });
    assert.equal(harness.confirmCalls.length, 1);
    assert.match(harness.confirmCalls[0], /settings\.security\.domainsConfirm/);
    assert.match(harness.confirmCalls[0], /example\.com, corp\.example\.jp/);
    assert.equal(harness.posts.length, 1);
  });

  it('does not save when the operator declines', async () => {
    const harness = makeHarness();
    harness.context.confirmResult = false;
    await save(harness, { enabled: true, domains: 'example.com' });
    assert.equal(harness.confirmCalls.length, 1);
    assert.deepEqual(harness.posts, []);
  });

  it('does not prompt for an email-only allowlist', async () => {
    const harness = makeHarness();
    await save(harness, { enabled: true, domains: '' });
    assert.deepEqual(harness.confirmCalls, []);
    assert.equal(harness.posts.length, 1);
  });

  it('does not prompt while OIDC stays disabled', async () => {
    const harness = makeHarness();
    await save(harness, { enabled: false, domains: 'example.com' });
    assert.deepEqual(harness.confirmCalls, []);
    assert.equal(harness.posts.length, 1);
  });
});
