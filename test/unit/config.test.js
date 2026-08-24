// Unit tests for src/config.js (file I/O helpers)
// Run: node --test test/unit/config.test.js
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { loadFile, loadFileOrThrow, saveFile, persistSecret } = require('../../src/config');

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

describe('loadFileOrThrow', () => {
  it('returns {} when file does not exist', () => {
    const result = loadFileOrThrow('/nonexistent/path/config.json');
    assert.deepEqual(result, {});
  });

  it('throws when JSON is malformed', () => {
    fs.writeFileSync(tmpFile, '{"foo":');
    assert.throws(() => loadFileOrThrow(tmpFile), SyntaxError);
  });

  it('repairs overly broad permissions before reading credentials', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ ok: true }), { mode: 0o644 });
    fs.chmodSync(tmpFile, 0o644);
    assert.deepEqual(loadFileOrThrow(tmpFile), { ok: true });
    assert.equal(fs.statSync(tmpFile).mode & 0o777, 0o600);
  });

  it('refuses a symbolic-link configuration path', { skip: process.platform === 'win32' }, () => {
    const target = `${tmpFile}.target`;
    const link = `${tmpFile}.link`;
    fs.writeFileSync(target, JSON.stringify({ secret: true }), { mode: 0o600 });
    try {
      fs.symlinkSync(target, link);
      assert.throws(() => loadFileOrThrow(link), /symbolic-link/);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });
});

describe('saveFile + loadFile round-trip', () => {
  it('saves and reads back correctly', () => {
    const data = { yamaha: { ip: '192.168.1.1' }, general: { homeCountry: 'JP' } };
    saveFile(data, tmpFile);
    const loaded = loadFile(tmpFile);
    assert.deepEqual(loaded, data);
  });

  it('writes the final config with owner-only permissions', () => {
    saveFile({ ok: true }, tmpFile);
    assert.equal(fs.statSync(tmpFile).mode & 0o777, 0o600);
  });

  it('propagates write failures without leaving a temporary file', () => {
    const target = path.join(os.tmpdir(), `missing-egressview-dir-${Date.now()}`, 'config.json');
    assert.throws(() => saveFile({ ok: true }, target));
    const parent = path.dirname(target);
    assert.equal(fs.existsSync(parent), false);
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

  it('does not overwrite a malformed config file', () => {
    fs.writeFileSync(tmpFile, '{"yamaha":');
    assert.throws(() => persistSecret('yamaha', { pass: 'yamaha-secret' }, tmpFile), SyntaxError);
    const raw = fs.readFileSync(tmpFile, 'utf8');
    assert.equal(raw, '{"yamaha":');
  });
});
