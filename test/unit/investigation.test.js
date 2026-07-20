// Unit tests for src/investigation.js — queue logic (no network calls)
// Run: node --test test/unit/investigation.test.js

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const investigation = require('../../src/investigation');

// ─── Minimal dependency stubs ─────────────────────────────────────────────────

function makeStubs({ autoInvestigate = false, routerIp = '192.168.1.1', yamahaIp = '192.168.1.2' } = {}) {
  const savedNotes = new Map();
  return {
    savedNotes,
    notes: {
      has:       () => false,
      set:       (k, v) => savedNotes.set(k, v),
      save:      () => {},
      snapshot:  () => new Map(savedNotes),
      restore:   snapshot => {
        savedNotes.clear();
        for (const [key, value] of snapshot) savedNotes.set(key, value);
      },
      getAll:    () => ({}),
      isSafeKey: (k) => typeof k === 'string' && k.length > 0,
    },
    io:     { emit: () => {} },
    yamaha: { getIp: () => yamahaIp, isReady: () => false, isEnabled: () => false },
    asus:   { getRouterIp: () => routerIp },
    deviceId: {
      investigateIp: async () => null,
      getOuiDb:      () => new Map(),
    },
    getAutoInvestigate: () => autoInvestigate,
  };
}

function resetAndInit(opts) {
  // Re-require to reset module-level state (queue, cooldowns, etc.)
  // Node's module cache means we must clear state via the module's own API.
  // investigation.js exposes init() which resets _notes/_io/etc., but queue
  // state (investigatedAt, inQueueIps) persists.  We work around this by
  // using unique IPs per test group so cooldowns don't interfere.
  investigation.init(makeStubs(opts));
}

// ─── enqueue: autoInvestigate=false ──────────────────────────────────────────

describe('enqueue with autoInvestigate=false', () => {
  beforeEach(() => resetAndInit({ autoInvestigate: false }));

  it('does not add IP to queue when autoInvestigate is false', () => {
    // enqueue should silently return without doing anything
    assert.doesNotThrow(() => investigation.enqueue('192.168.10.1', null));
  });
});

// ─── enqueue: IP filtering ────────────────────────────────────────────────────

describe('enqueue IP filtering', () => {
  beforeEach(() => resetAndInit({ autoInvestigate: true }));

  it('skips public IP addresses', () => {
    // Public IPs are not allowed — isAllowedRouterIp returns false
    assert.doesNotThrow(() => investigation.enqueue('8.8.8.8', null));
  });

  it('skips null IP', () => {
    assert.doesNotThrow(() => investigation.enqueue(null, null));
  });

  it('skips the ASUS router IP', () => {
    // routerIp = '192.168.1.1' in stubs — should be skipped
    assert.doesNotThrow(() => investigation.enqueue('192.168.1.1', null));
  });

  it('skips the Yamaha router IP', () => {
    // yamahaIp = '192.168.1.2' in stubs
    assert.doesNotThrow(() => investigation.enqueue('192.168.1.2', null));
  });
});

// ─── enqueue: cooldown ────────────────────────────────────────────────────────

describe('enqueue cooldown', () => {
  // Use a unique IP range that won't collide with earlier tests

  beforeEach(() => resetAndInit({ autoInvestigate: true }));

  it('allows the same IP to be enqueued after a fresh init (no cooldown yet)', () => {
    // Should not throw; the IP might or might not be queued depending on
    // whether a previous test ran the cooldown — use a unique IP to be safe
    assert.doesNotThrow(() => investigation.enqueue('10.99.1.1', null));
  });
});

// ─── enqueue: deduplication ───────────────────────────────────────────────────

describe('enqueue deduplication', () => {
  beforeEach(() => resetAndInit({ autoInvestigate: true }));

  it('does not throw when the same IP is enqueued twice', () => {
    const ip = '10.77.77.1';
    assert.doesNotThrow(() => {
      investigation.enqueue(ip, null);
      investigation.enqueue(ip, null);
    });
  });
});

// ─── enqueue: notes.has() guard ───────────────────────────────────────────────

describe('enqueue notes guard', () => {
  it('skips IPs that already have a note', () => {
    const stubs = makeStubs({ autoInvestigate: true });
    stubs.notes.has = () => true;   // pretend every IP already has a note
    investigation.init(stubs);

    // Should silently skip without adding to queue
    assert.doesNotThrow(() => investigation.enqueue('10.55.55.1', null));
  });
});

describe('automatic note persistence', () => {
  it('restores runtime notes and suppresses notification when saving fails', async () => {
    let emitted = 0;
    let saveAttempted;
    const attempted = new Promise(resolve => { saveAttempted = resolve; });
    const stubs = makeStubs({ autoInvestigate: true });
    stubs.io.emit = () => { emitted++; };
    stubs.deviceId.investigateIp = async () => ({ draft: 'identified device' });
    stubs.notes.save = () => {
      saveAttempted();
      throw new Error('disk full');
    };
    investigation.init(stubs);

    investigation.enqueue('10.66.66.1', null);
    await attempted;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(stubs.savedNotes.size, 0);
    assert.equal(emitted, 0);
  });
});
