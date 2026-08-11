const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'display-scope.js'),
  'utf8'
)
  .replace(/^import\s[^;]+;?\s*$/gm, '')
  .replace(/^export\s+\{[\s\S]*?^\};?\s*$/gm, '');

function translation(key) {
  return ({
    'source.all': 'All sources',
    'source.selector.label': 'Collection source to display',
    'source.group.routers': 'Routers',
    'source.group.agents': 'Mac Agents',
    'source.router.fallback': 'Router',
    'source.router.idFallback': 'Router {id}',
    'source.agent.fallback': 'Mac Agent {id}',
    'source.online': 'Online',
    'source.offline': 'Offline',
    'source.unavailable': 'Source unavailable',
  })[key] || key;
}

class FakeElement {
  constructor(tagName = '') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this.label = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
}

function createHarness(storedScope = null) {
  const values = new Map();
  if (storedScope) values.set('egressview_display_scope_v1', JSON.stringify(storedScope));
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const selector = new FakeElement('select');
  const events = [];
  const context = {
    console,
    Date,
    JSON,
    Map,
    Set,
    Promise,
    URLSearchParams,
    localStorage: storage,
    t: translation,
    tVars: (key, vars) => Object.entries(vars).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      translation(key)
    ),
    _BASE: '',
    document: {
      getElementById: id => id === 'source-filter-select' ? selector : null,
      createElement: tag => new FakeElement(tag),
    },
    window: {
      addEventListener() {},
      dispatchEvent: event => events.push(event),
    },
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options?.detail; }
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'display-scope.js' });
  return { context, selector, values };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('display source scope', () => {
  it('accepts only stable router/agent IDs and persists a valid choice', () => {
    const { context, values } = createHarness();
    assert.equal(vm.runInContext("normalizeScope({ sourceKind: 'router', sourceId: 'router-1' }).sourceId", context), 'router-1');
    assert.equal(vm.runInContext("normalizeScope({ sourceKind: 'other', sourceId: 'x' })", context), null);
    assert.equal(vm.runInContext("normalizeScope({ sourceKind: 'agent', sourceId: 'bad\\nvalue' })", context), null);
    vm.runInContext("setDisplayScope({ sourceKind: 'agent', sourceId: 'agent-1' })", context);
    assert.deepEqual(JSON.parse(values.get('egressview_display_scope_v1')), {
      sourceKind: 'agent', sourceId: 'agent-1',
    });
  });

  it('adds a selected scope to query parameters and request bodies', () => {
    const { context } = createHarness();
    vm.runInContext("setDisplayScope({ sourceKind: 'router', sourceId: 'router-1' })", context);
    context.params = new URLSearchParams({ from: '1' });
    assert.equal(vm.runInContext("appendDisplayScope(params).get('sourceId')", context), 'router-1');
    assert.deepEqual(plain(vm.runInContext("withDisplayScope({ from: 1 })", context)), {
      from: 1, sourceKind: 'router', sourceId: 'router-1',
    });
  });

  it('builds safe router labels and stable duplicate/fallback Agent labels', () => {
    const { context } = createHarness();
    context.routers = [
      { id: 'r1', enabled: true, hostName: 'edge-cisco', displayName: 'Core\nRouter', ip: '192.0.2.1', ready: true },
      { id: 'r3', enabled: true, displayName: 'Fallback RTX', ip: '192.0.2.3', ready: false },
      { id: 'r2', enabled: false, displayName: 'Disabled', ip: '192.0.2.2' },
    ];
    context.agents = [
      { agentId: 'aaaaaaaa-1', hostName: 'MacBook', lastSeenAt: 1000 },
      { agentId: 'bbbbbbbb-2', hostName: 'macbook', lastSeenAt: 0 },
      { agentId: 'cccccccc-3', hostName: '\n', lastSeenAt: 0 },
      { agentId: 'revoked', hostName: 'Old', revokedAt: 1 },
    ];
    const routers = plain(vm.runInContext('activeRouterSources(routers)', context));
    const agents = plain(vm.runInContext('activeAgentSources(agents, 1000)', context));
    assert.deepEqual(routers.map(item => item.label), [
      'edge-cisco (192.0.2.1)',
      'Fallback RTX (192.0.2.3)',
    ]);
    assert.deepEqual(agents.map(item => item.label), [
      'MacBook (aaaaaaaa) · Online',
      'macbook (bbbbbbbb) · Offline',
      'Mac Agent cccccccc · Offline',
    ]);
    context.routersResult = routers;
    context.agentsResult = agents;
    vm.runInContext('routerSources = routersResult; agentSources = agentsResult', context);
    assert.equal(vm.runInContext("getDisplayScopeLabel({ sourceKind: 'router', sourceId: 'r1' })", context), 'edge-cisco (192.0.2.1)');
    assert.equal(vm.runInContext("getDisplayScopeLabel({ sourceKind: 'agent', sourceId: 'aaaaaaaa-1' })", context), 'MacBook (aaaaaaaa)');
    assert.equal(vm.runInContext("getDisplayScopeLabel({ sourceKind: 'router', sourceId: 'deleted-router' })", context), 'Router deleted-');
  });

  it('falls back to All only after both complete catalogs confirm removal', async () => {
    const { context, selector, values } = createHarness({ sourceKind: 'agent', sourceId: 'gone-agent' });
    const notices = [];
    context.notices = notices;
    context.request = async url => ({
      ok: true,
      json: async () => url.endsWith('/api/routers') ? { routers: [] } : { agents: [] },
    });
    await vm.runInContext('initDisplayScopeSelector({ request, notify: message => notices.push(message) })', context);
    assert.equal(selector.value, '');
    assert.equal(values.has('egressview_display_scope_v1'), false);
    assert.deepEqual(notices, ['Source unavailable']);
  });

  it('keeps a stored selection when either catalog request is temporarily unavailable', async () => {
    const { context, values } = createHarness({ sourceKind: 'agent', sourceId: 'agent-1' });
    context.request = async url => {
      if (url.endsWith('/api/agents')) throw new Error('offline');
      return { ok: true, json: async () => ({ routers: [] }) };
    };
    await vm.runInContext('initDisplayScopeSelector({ request })', context);
    assert.deepEqual(JSON.parse(values.get('egressview_display_scope_v1')), {
      sourceKind: 'agent', sourceId: 'agent-1',
    });
  });
});
