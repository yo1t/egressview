'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeRouterHostName,
  extractCiscoHostName,
  extractYamahaConsolePrompt,
} = require('../../src/pollers/router-prompt');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

describe('router shell prompt display names', () => {
  it('extracts a plain Cisco IOS hostname from the final shell prompt', () => {
    assert.equal(extractCiscoHostName(fixture('cisco-shell-prompt.txt')), 'edge-cisco-01');
    assert.equal(extractCiscoHostName('Router>\r\n'), 'Router');
  });

  it('does not mistake command output or configuration mode for a Cisco hostname', () => {
    assert.equal(extractCiscoHostName('show run\nRouter(config)#'), '');
    assert.equal(extractCiscoHostName('banner says forged#\nPassword:'), '');
  });

  it('extracts Yamaha console prompt text and rejects mode-like lines', () => {
    assert.equal(extractYamahaConsolePrompt(fixture('yamaha-shell-prompt.txt')), 'office-rtx');
    assert.equal(extractYamahaConsolePrompt('\x1b[32mTokyo RTX\x1b[0m#'), 'Tokyo RTX');
    assert.equal(extractYamahaConsolePrompt('RTX(config)#'), '');
  });

  it('normalizes control characters and bounds persisted display text', () => {
    assert.equal(normalizeRouterHostName('core\nrouter\t01'), 'core router 01');
    assert.equal(normalizeRouterHostName('x'.repeat(100)).length, 80);
  });
});
