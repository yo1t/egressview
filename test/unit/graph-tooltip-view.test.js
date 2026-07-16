'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const graphPanelsJs = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'graph-panels.js'),
  'utf8'
);
const sectionStart = graphPanelsJs.indexOf('// ─── Tooltip');
const sectionEnd = graphPanelsJs.indexOf('// ─── Side Panel', sectionStart);
const tooltipJs = graphPanelsJs.slice(sectionStart, sectionEnd).replace(/^export\s+/gm, '');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this._textContent = '';
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
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
  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    return descendants(this).filter(element => className && element.classList.contains(className));
  }
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

function makeHarness() {
  const tooltip = new FakeElement('div');
  const graphContainer = {
    getBoundingClientRect: () => ({ left: 10, top: 5, width: 500 }),
  };
  const context = {
    console,
    Number,
    document: {
      createElement: tag => new FakeElement(tag),
      getElementById: id => id === 'tooltip' ? tooltip : graphContainer,
    },
    fmtBytes: value => `<bytes:${value}>`,
  };
  vm.createContext(context);
  vm.runInContext(tooltipJs, context, { filename: 'graph-tooltip.js' });
  return { context, tooltip };
}

describe('Graph tooltip DOM rendering', () => {
  it('renders client values as text with optional details', () => {
    const { context, tooltip } = makeHarness();
    context.showTooltip({ clientX: 100, clientY: 50 }, {
      type: 'client',
      client: {
        name: '<script>Client</script>',
        ip: '<img src=x onerror=alert(1)>',
        mac: '<svg onload=alert(1)>',
        vendor: '<b>Vendor</b>',
        dnsName: '<i>dns</i>',
        mdnsName: '<u>mdns</u>',
        ipv6Addrs: ['2001:db8::1'],
        summarySessions: 1234,
        rxRate: 10,
        txRate: 20,
        rssi: -42,
      },
    });

    assert.match(tooltip.textContent, /<script>Client<\/script>/);
    assert.match(tooltip.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(tooltip.textContent, /<svg onload=alert\(1\)>/);
    assert.match(tooltip.textContent, /IPv6/);
    assert.match(tooltip.textContent, /summary: 1,234 sessions/);
    assert.match(tooltip.textContent, /↓ <bytes:10> ↑ <bytes:20>/);
    assert.match(tooltip.textContent, /RSSI: -42 dBm/);
    assert.equal(tooltip.querySelectorAll('.proto-v6-grey').length, 1);
    assert.equal(tooltip.querySelectorAll('.graph-tooltip-summary').length, 1);
    const tags = descendants(tooltip).map(element => element.tagName);
    assert.equal(tags.includes('SCRIPT'), false);
    assert.equal(tags.includes('IMG'), false);
    assert.equal(tags.includes('SVG'), false);
    assert.equal(tooltip.classList.contains('is-visible'), true);
    assert.equal(tooltip.style.left, '104px');
    assert.equal(tooltip.style.top, '35px');

    context.hideTooltip();
    assert.equal(tooltip.classList.contains('is-visible'), false);
  });

  it('renders organization and fallback values as text', () => {
    const { context, tooltip } = makeHarness();
    context.showTooltip({ clientX: 100, clientY: 50 }, {
      type: 'org', label: '<img src=x>', flag: '<script>flag</script>',
      country: '<svg>JP</svg>', totalSessions: 20, summary: true,
    });
    assert.match(tooltip.textContent, /<img src=x>/);
    assert.match(tooltip.textContent, /<script>flag<\/script>/);
    assert.match(tooltip.textContent, /<svg>JP<\/svg>/);
    assert.match(tooltip.textContent, /20 sessions/);
    assert.match(tooltip.textContent, /summary destination/);
    assert.equal(descendants(tooltip).some(element => ['SCRIPT', 'IMG', 'SVG'].includes(element.tagName)), false);

    context.showTooltip({ clientX: 100, clientY: 50 }, { type: 'router', label: '<b>Router</b>' });
    assert.equal(tooltip.textContent, '<b>Router</b>');
    assert.equal(descendants(tooltip).some(element => element.tagName === 'B'), false);
  });
});
