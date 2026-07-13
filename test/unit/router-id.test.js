// Unit tests for src/router-id.js (P2-30 PR 1 spec)
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidRouterId,
  isReservedRouterId,
  migratedRouterId,
  legacyPlaceholderId,
  generateRouterId,
  MIGRATED_IDS,
} = require('../../src/router-id');

describe('isValidRouterId', () => {
  it('accepts spec-conforming ids', () => {
    assert.ok(isValidRouterId('yamaha1'));
    assert.ok(isValidRouterId('cisco1'));
    assert.ok(isValidRouterId('cisco-3f9a2c1b'));
    assert.ok(isValidRouterId('legacy-yamaha'));
    assert.ok(isValidRouterId('abc'));
  });
  it('rejects wrong shapes', () => {
    assert.ok(!isValidRouterId(''));
    assert.ok(!isValidRouterId('ab'));                    // too short
    assert.ok(!isValidRouterId('1cisco'));                // digit first
    assert.ok(!isValidRouterId('-cisco'));                // hyphen first
    assert.ok(!isValidRouterId('Cisco1'));                // uppercase
    assert.ok(!isValidRouterId('cisco_1'));               // underscore
    assert.ok(!isValidRouterId('a'.repeat(33)));          // too long
    assert.ok(!isValidRouterId(null));
    assert.ok(!isValidRouterId(123));
  });
});

describe('migratedRouterId', () => {
  it('returns fixed deterministic ids for legacy config sections', () => {
    assert.equal(migratedRouterId('yamaha'), 'yamaha1');
    assert.equal(migratedRouterId('cisco'), 'cisco1');
  });
  it('throws for unknown kinds', () => {
    assert.throws(() => migratedRouterId('juniper'));
    assert.throws(() => migratedRouterId(''));
  });
});

describe('legacyPlaceholderId', () => {
  it('maps known legacy sources', () => {
    assert.equal(legacyPlaceholderId('yamaha'), 'legacy-yamaha');
    assert.equal(legacyPlaceholderId('cisco'), 'legacy-cisco');
  });
  it('sanitizes unknown source values into the id character set', () => {
    const id = legacyPlaceholderId('Some Router!!/v2');
    assert.ok(isValidRouterId(id), `sanitized id must be valid: ${id}`);
    assert.ok(id.startsWith('legacy-'));
  });
  it('handles empty and whitespace sources', () => {
    assert.equal(legacyPlaceholderId(''), 'legacy-unknown');
    assert.equal(legacyPlaceholderId('   '), 'legacy-unknown');
  });
  it('truncates long sources to the 32-char limit', () => {
    const id = legacyPlaceholderId('x'.repeat(100));
    assert.ok(id.length <= 32);
    assert.ok(isValidRouterId(id));
  });
});

describe('generateRouterId', () => {
  it('produces <kind>-<8 hex> ids that pass validation', () => {
    const id = generateRouterId('cisco');
    assert.match(id, /^cisco-[0-9a-f]{8}$/);
    assert.ok(isValidRouterId(id));
  });
  it('avoids collisions with existing ids', () => {
    const existing = new Set();
    for (let i = 0; i < 50; i++) existing.add(generateRouterId('yamaha', existing));
    assert.equal(existing.size, 50);
  });
  it('throws for unknown kinds', () => {
    assert.throws(() => generateRouterId('juniper'));
  });
});

describe('isReservedRouterId', () => {
  it('reserves migrated ids and the legacy- prefix', () => {
    assert.ok(isReservedRouterId(MIGRATED_IDS.yamaha));
    assert.ok(isReservedRouterId(MIGRATED_IDS.cisco));
    assert.ok(isReservedRouterId('legacy-yamaha'));
    assert.ok(isReservedRouterId('legacy-whatever'));
  });
  it('does not reserve generated-style ids', () => {
    assert.ok(!isReservedRouterId('cisco-3f9a2c1b'));
    assert.ok(!isReservedRouterId('yamaha-00000000'));
  });
});
