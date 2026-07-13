'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadRouterConfig, migrateRouterConfigFile, normalizeRouterRecord } = require('../../src/router-config');

function tempConfig(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-router-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  return file;
}

describe('legacy router config migration', () => {
  it('maps legacy sections to deterministic router ids and preserves secrets', () => {
    const file = tempConfig({
      yamaha: { ip: '192.168.1.1', user: 'admin', pass: 'secret-y', nat: '200', enabled: true, hostFp: 'fp-y' },
      cisco: { ip: '192.168.1.2', user: 'cisco', pass: 'secret-c', enablePass: 'enable-c', enabled: true, hostFp: 'fp-c' },
      general: { language: 'ja' },
    });
    const result = migrateRouterConfigFile(file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(result.migrated, true);
    assert.deepEqual(saved.routers.map(r => r.id), ['yamaha1', 'cisco1']);
    assert.equal(saved.routers[0].pass, 'secret-y');
    assert.equal(saved.routers[0].nat, '200');
    assert.equal(saved.routers[1].enablePass, 'enable-c');
    assert.equal(saved.routers[1].hostFp, 'fp-c');
    assert.deepEqual(saved.general, { language: 'ja' });
    assert.ok(saved.yamaha && saved.cisco, 'legacy sections remain available for rollback');
    assert.ok(fs.existsSync(`${file}.pre-routers-v1.bak`));
    assert.equal(fs.statSync(`${file}.pre-routers-v1.bak`).mode & 0o777, 0o600);
  });

  it('does not rewrite a config that already has routers', () => {
    const file = tempConfig({ routers: [{ id: 'cisco-12345678', kind: 'cisco', ip: '192.168.1.2', user: 'u', pass: 'p' }] });
    const before = fs.readFileSync(file, 'utf8');
    const result = migrateRouterConfigFile(file);
    assert.equal(result.migrated, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(`${file}.pre-routers-v1.bak`), false);
  });

  it('creates a fresh verified backup when the fixed backup name already exists', () => {
    const file = tempConfig({ yamaha: { ip: '192.168.1.1', user: 'admin', pass: 'current-secret' } });
    fs.writeFileSync(`${file}.pre-routers-v1.bak`, JSON.stringify({ yamaha: { pass: 'stale-secret' } }), { mode: 0o600 });
    const result = migrateRouterConfigFile(file);
    assert.notEqual(result.backupPath, `${file}.pre-routers-v1.bak`);
    const freshBackup = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'));
    assert.equal(freshBackup.yamaha.pass, 'current-secret');
  });

  it('ignores duplicate, tombstoned, and malformed stored ids', () => {
    const loaded = loadRouterConfig({
      routerTombstones: ['cisco-deadbeef'],
      routers: [
        { id: 'cisco-12345678', kind: 'cisco' },
        { id: 'cisco-12345678', kind: 'cisco' },
        { id: 'cisco-deadbeef', kind: 'cisco' },
        { id: 'Bad_ID', kind: 'cisco' },
      ],
    });
    assert.deepEqual(loaded.routers.map(r => r.id), ['cisco-12345678']);
  });
});

describe('normalizeRouterRecord', () => {
  it('keeps saved secrets when edit fields are empty and resets TOFU on IP change', () => {
    const existing = {
      id: 'cisco-12345678', kind: 'cisco', displayName: 'Edge', ip: '192.168.1.2', user: 'u',
      pass: 'saved', enablePass: 'enable', hostFp: 'fingerprint', enabled: true, createdAt: 1,
    };
    const edited = normalizeRouterRecord({ ip: '192.168.1.3', pass: '', enablePass: '' }, { existing });
    assert.equal(edited.pass, 'saved');
    assert.equal(edited.enablePass, 'enable');
    assert.equal(edited.hostFp, '');
    assert.equal(edited.id, existing.id);
  });
});
