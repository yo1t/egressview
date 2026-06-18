// Unit tests for src/config.js (file I/O helpers)
// Run: node --test test/unit/config.test.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { loadFile, saveFile, persistSecret } = require('../../src/config');

let tmpFile;

before(() => {
  tmpFile = path.join(os.tmpdir(), `egressview-config-test-${Date.now()}.json`);
});
after(() => {
  try { fs.unlinkSync(tmpFile); } catch {}
});

describe('loadFile', () => {
  it('returns {} when file does not exist', () => {
    const result = loadFile('/nonexistent/path/config.json');
    assert.deepEqual(result, {});
  });

  it('parses a valid JSON file', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ foo: 'bar' }));
    assert.deepEqual(loadFile(tmpFile), { foo: 'bar' });
  });
});

describe('saveFile + loadFile round-trip', () => {
  it('saves and reads back correctly', () => {
    const data = { yamaha: { ip: '192.168.1.1' }, general: { homeCountry: 'JP' } };
    saveFile(data, tmpFile);
    const loaded = loadFile(tmpFile);
    assert.deepEqual(loaded, data);
  });
});

describe('persistSecret', () => {
  it('merges new keys into an existing section without overwriting others', () => {
    saveFile({ yamaha: { ip: '192.168.1.1', pass: 'old' }, general: { homeCountry: 'JP' } }, tmpFile);
    persistSecret('yamaha', { pass: 'new', user: 'admin' }, tmpFile);
    const result = loadFile(tmpFile);
    assert.equal(result.yamaha.pass, 'new');
    assert.equal(result.yamaha.user, 'admin');
    assert.equal(result.yamaha.ip, '192.168.1.1');    // unchanged
    assert.equal(result.general.homeCountry, 'JP');   // other section intact
  });

  it('creates a new section if it does not exist', () => {
    saveFile({ general: { homeCountry: 'JP' } }, tmpFile);
    persistSecret('slack', { token: 'xoxb-123' }, tmpFile);
    const result = loadFile(tmpFile);
    assert.equal(result.slack.token, 'xoxb-123');
    assert.equal(result.general.homeCountry, 'JP');
  });

  it('does not overwrite unrelated sections', () => {
    saveFile({ asus: { ip: '192.168.1.2', pass: 'asus-secret' }, yamaha: { ip: '192.168.1.1' } }, tmpFile);
    persistSecret('yamaha', { pass: 'yamaha-secret' }, tmpFile);
    const result = loadFile(tmpFile);
    assert.equal(result.asus.pass, 'asus-secret');   // untouched
  });
});
