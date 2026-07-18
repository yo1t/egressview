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
  sourceRouterIdMap,
  expandSourceToRouterIds,
  routerKindForId,
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
  it('supports Linux conntrack router ids', () => {
    assert.match(generateRouterId('conntrack'), /^conntrack-[0-9a-f]{8}$/);
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

describe('sourceRouterIdMap', () => {
  it('maps to migrated ids while the config section exists', () => {
    assert.deepEqual(sourceRouterIdMap({ hasYamahaConfig: true, hasCiscoConfig: true }),
      { yamaha: 'yamaha1', cisco: 'cisco1' });
  });
  it('maps to legacy placeholders when the config was deleted', () => {
    assert.deepEqual(sourceRouterIdMap({ hasYamahaConfig: false, hasCiscoConfig: false }),
      { yamaha: 'legacy-yamaha', cisco: 'legacy-cisco' });
  });
  it('handles mixed presence', () => {
    assert.deepEqual(sourceRouterIdMap({ hasYamahaConfig: true, hasCiscoConfig: false }),
      { yamaha: 'yamaha1', cisco: 'legacy-cisco' });
  });
});

describe('expandSourceToRouterIds', () => {
  const map = { yamaha: 'yamaha1', cisco: 'cisco1' };
  it('expands single sources', () => {
    assert.deepEqual(expandSourceToRouterIds('yamaha', map), ['yamaha1']);
    assert.deepEqual(expandSourceToRouterIds('cisco', map), ['cisco1']);
  });
  it('expands the merged source into both routers', () => {
    assert.deepEqual(expandSourceToRouterIds('yamaha+cisco', map), ['yamaha1', 'cisco1']);
  });
  it('maps inspect to the yamaha router (INSPECT is a Yamaha RTX feature)', () => {
    assert.deepEqual(expandSourceToRouterIds('inspect', map), ['yamaha1']);
  });
  it('maps unknown sources to legacy placeholders without guessing', () => {
    assert.deepEqual(expandSourceToRouterIds('nat', map), ['legacy-nat']);
    assert.deepEqual(expandSourceToRouterIds('', map), ['legacy-unknown']);
  });
});

describe('routerKindForId', () => {
  const map = { yamaha: 'yamaha1', cisco: 'legacy-cisco' };
  it('recognizes mapped and legacy ids of both kinds', () => {
    assert.equal(routerKindForId('yamaha1', map), 'yamaha');
    assert.equal(routerKindForId('legacy-yamaha', map), 'yamaha');
    assert.equal(routerKindForId('legacy-cisco', map), 'cisco');
  });
  it('returns unknown for anything else', () => {
    assert.equal(routerKindForId('legacy-mystery', map), 'unknown');
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
