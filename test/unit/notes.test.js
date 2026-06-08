// Unit tests for src/notes.js
// Run: node --test test/unit/notes.test.js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Use a temporary in-memory-ish approach: monkey-patch the module's internal
// state via a test-only reset helper. We test all exported functions directly.
const notes = require('../../src/notes');

// Reset internal state between tests by loading from an empty object
// (override the module's NOTES_FILE read to avoid touching disk)
function resetNotes() {
  // Call load() on a non-existent path is caught — notes becomes {}
  // Instead, exercise set/del directly to start clean
  for (const k of Object.keys(notes.getAll())) notes.del(k);
}

describe('notes.isSafeKey', () => {
  it('accepts a valid IPv4 address', () => {
    assert.ok(notes.isSafeKey('192.168.1.1'));
  });

  it('accepts a valid MAC address', () => {
    assert.ok(notes.isSafeKey('aa:bb:cc:dd:ee:ff'));
  });

  it('accepts a composite IP|MAC key', () => {
    assert.ok(notes.isSafeKey('192.168.1.1|aa:bb:cc:dd:ee:ff'));
  });

  it('accepts a composite MAC|IP key', () => {
    assert.ok(notes.isSafeKey('aa:bb:cc:dd:ee:ff|192.168.1.50'));
  });

  it('rejects a path-like string', () => {
    assert.ok(!notes.isSafeKey('../etc/passwd'));
  });

  it('rejects an empty string', () => {
    assert.ok(!notes.isSafeKey(''));
  });

  it('rejects a string over 96 chars', () => {
    assert.ok(!notes.isSafeKey('192.168.1.1|' + 'a'.repeat(90)));
  });

  it('rejects non-string input', () => {
    assert.ok(!notes.isSafeKey(null));
    assert.ok(!notes.isSafeKey(123));
  });
});

describe('notes CRUD', () => {
  beforeEach(resetNotes);

  it('set and get a note', () => {
    notes.set('192.168.1.1', 'hello');
    assert.equal(notes.get('192.168.1.1'), 'hello');
  });

  it('del removes a note', () => {
    notes.set('192.168.1.5', 'bye');
    notes.del('192.168.1.5');
    assert.equal(notes.get('192.168.1.5'), undefined);
  });

  it('getAll returns all notes', () => {
    notes.set('10.0.0.1', 'a');
    notes.set('10.0.0.2', 'b');
    const all = notes.getAll();
    assert.equal(all['10.0.0.1'], 'a');
    assert.equal(all['10.0.0.2'], 'b');
  });
});

describe('notes.has', () => {
  beforeEach(resetNotes);

  it('returns true when IP matches a plain IP key', () => {
    notes.set('192.168.1.10', 'note');
    assert.ok(notes.has('192.168.1.10', null));
  });

  it('returns true when MAC matches a plain MAC key', () => {
    notes.set('aa:bb:cc:dd:ee:ff', 'note');
    assert.ok(notes.has(null, 'aa:bb:cc:dd:ee:ff'));
  });

  it('returns true when IP matches the IP part of a composite key', () => {
    notes.set('192.168.1.20|aa:bb:cc:dd:ee:ff', 'note');
    assert.ok(notes.has('192.168.1.20', null));
  });

  it('returns false when neither ip nor mac is stored', () => {
    assert.ok(!notes.has('10.0.0.99', 'de:ad:be:ef:00:01'));
  });
});

describe('notes.clearByIpMac', () => {
  beforeEach(resetNotes);

  it('removes composite key that matches the IP', () => {
    notes.set('192.168.1.30|aa:bb:cc:dd:ee:ff', 'old');
    notes.clearByIpMac('192.168.1.30', null);
    assert.equal(notes.get('192.168.1.30|aa:bb:cc:dd:ee:ff'), undefined);
  });

  it('leaves unrelated keys intact', () => {
    notes.set('10.0.0.1', 'keep');
    notes.set('192.168.1.30|aa:bb:cc:dd:ee:ff', 'remove');
    notes.clearByIpMac('192.168.1.30', null);
    assert.equal(notes.get('10.0.0.1'), 'keep');
  });
});

// ─── Step 8: UUID key + getForDevice ─────────────────────────────────────────

describe('notes: step 8 — UUID key support', () => {
  beforeEach(resetNotes);

  it('isSafeKey: UUID 形式を受け付ける', () => {
    assert.ok(notes.isSafeKey('550e8400-e29b-41d4-a716-446655440000'));
  });

  it('isSafeKey: 不正 UUID は拒否する', () => {
    assert.ok(!notes.isSafeKey('not-a-uuid'));
    assert.ok(!notes.isSafeKey('550e8400-e29b-41d4-a716-44665544000Z'));  // Z は16進外
  });

  it('UUID キーでメモを保存・取得できる', () => {
    const id = '550e8400-e29b-41d4-a716-446655440001';
    notes.set(id, 'device note');
    assert.equal(notes.get(id), 'device note');
  });
});

describe('notes: step 8 — getForDevice', () => {
  beforeEach(resetNotes);

  it('deviceId キーが最優先で返る', () => {
    const id = '550e8400-e29b-41d4-a716-446655440002';
    notes.set(id, 'canonical note');
    notes.set('10.0.0.1', 'old ip note');
    assert.equal(notes.getForDevice(id, '10.0.0.1', null), 'canonical note');
  });

  it('deviceId がなければ IP|MAC キーにフォールバック', () => {
    notes.set('10.0.0.2|aa:bb:cc:00:00:01', 'composite note');
    assert.equal(notes.getForDevice(null, '10.0.0.2', 'aa:bb:cc:00:00:01'), 'composite note');
  });

  it('IP|MAC もなければ IP 単体にフォールバック', () => {
    notes.set('10.0.0.3', 'ip note');
    assert.equal(notes.getForDevice(null, '10.0.0.3', null), 'ip note');
  });

  it('MAC 単体にフォールバック', () => {
    notes.set('aa:bb:cc:00:00:02', 'mac note');
    assert.equal(notes.getForDevice(null, null, 'aa:bb:cc:00:00:02'), 'mac note');
  });

  it('どのキーにもメモがなければ null を返す', () => {
    assert.equal(notes.getForDevice('non-existent-id', '1.2.3.4', null), null);
  });
});
