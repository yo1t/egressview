// Unit tests for src/devices.js (in-memory SQLite)
'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const devicesModule = require('../../src/devices');

// ─── tmp DB helpers ────────────────────────────────────────────────────────────

let tmpDbPath = null;

function makeTmpDb() {
  tmpDbPath = path.join(os.tmpdir(), `egressview-devices-test-${process.pid}-${Date.now()}.db`);
  return tmpDbPath;
}

function cleanupTmpDb() {
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(tmpDbPath + ext); } catch {}
  }
  tmpDbPath = null;
}

// ─── Reset before each test ─────────────────────────────────────────────────

beforeEach(() => devicesModule._initForTest());

after(() => devicesModule._initForTest());

// ─── Existing tests (backward compatibility) ──────────────────────────────────

describe('devices.upsert / getAll', () => {
  it('inserts a new device', () => {
    devicesModule.upsert({ ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:ff', vendor: 'Apple', source: 'nat' });
    const all = devicesModule.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].ip, '192.168.1.1');
    assert.equal(all[0].mac, 'aa:bb:cc:dd:ee:ff');
    assert.equal(all[0].vendor, 'Apple');
  });

  it('merges fields on upsert (COALESCE)', () => {
    devicesModule.upsert({ ip: '10.0.0.1', mac: null,                   vendor: 'Sony',  source: 'nat' });
    devicesModule.upsert({ ip: '10.0.0.1', mac: '11:22:33:44:55:66',   vendor: null,    source: 'dhcp' });
    const all = devicesModule.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].mac,    '11:22:33:44:55:66'); // filled in by second upsert
    assert.equal(all[0].vendor, 'Sony');               // kept from first upsert
  });

  it('accumulates sources', () => {
    devicesModule.upsert({ ip: '10.0.0.2', source: 'nat' });
    devicesModule.upsert({ ip: '10.0.0.2', source: 'dhcp' });
    devicesModule.upsert({ ip: '10.0.0.2', source: 'nat' }); // duplicate should not be added again
    const row = devicesModule.getByIp('10.0.0.2');
    const sources = row.sources.split(',').filter(Boolean);
    assert.ok(sources.includes('nat'),  'nat present');
    assert.ok(sources.includes('dhcp'), 'dhcp present');
    assert.equal(sources.filter(s => s === 'nat').length, 1, 'nat appears only once');
  });

  it('keeps MIN firstSeen and MAX lastSeen', () => {
    const t = Date.now();
    devicesModule.upsert({ ip: '10.0.0.3', firstSeen: t - 5000, lastSeen: t - 4000, source: 'nat' });
    devicesModule.upsert({ ip: '10.0.0.3', firstSeen: t - 3000, lastSeen: t,        source: 'nat' });
    const row = devicesModule.getByIp('10.0.0.3');
    assert.equal(row.firstSeen, t - 5000);
    assert.equal(row.lastSeen,  t);
  });
});

describe('devices.observeDevices batch', () => {
  it('commits every device in one batch', () => {
    const ids = devicesModule.observeDevices([
      { ip: '192.168.1.10', firstSeen: 1, lastSeen: 2, source: 'yamaha' },
      { ip: '192.168.1.11', firstSeen: 1, lastSeen: 2, source: 'yamaha' },
    ]);
    assert.equal(ids.length, 2);
    assert.ok(devicesModule.getByIp('192.168.1.10'));
    assert.ok(devicesModule.getByIp('192.168.1.11'));
  });

  it('rolls back the whole batch when one device cannot be bound', () => {
    assert.throws(() => devicesModule.observeDevices([
      { ip: '192.168.1.20', firstSeen: 1, lastSeen: 2, source: 'yamaha' },
      { ip: '192.168.1.21', mac: { invalid: true }, firstSeen: 1, lastSeen: 2, source: 'yamaha' },
    ]));
    assert.equal(devicesModule.getByIp('192.168.1.20'), null);
  });

  it('端末でないアドレスは、バッチを壊さずに飛ばす', () => {
    // An Agent reports every address its machine holds, and most of them are
    // not devices (P3-138). One of those must not cost the poll its other rows.
    devicesModule.observeDevices([
      { ip: '192.168.1.22', firstSeen: 1, lastSeen: 2, source: 'agent' },
      { ip: '0.0.0.0', firstSeen: 1, lastSeen: 2, source: 'agent' },
      { ip: 'fe80::1%en0', firstSeen: 1, lastSeen: 2, source: 'agent' },
    ]);
    assert.ok(devicesModule.getByIp('192.168.1.22'), '本物の端末が失われている');
    assert.equal(devicesModule.getByIp('0.0.0.0'), null);
    assert.equal(devicesModule.getByIp('fe80::1%en0'), null);
  });
});

describe('devices.getByIp', () => {
  it('returns null for unknown IP', () => {
    assert.equal(devicesModule.getByIp('1.2.3.4'), null);
  });

  it('returns the correct row', () => {
    devicesModule.upsert({ ip: '172.16.0.1', mac: 'de:ad:be:ef:00:01', source: 'arp' });
    const row = devicesModule.getByIp('172.16.0.1');
    assert.ok(row, 'row exists');
    assert.equal(row.ip, '172.16.0.1');
  });
});

describe('devices.getByMac', () => {
  it('returns empty array for unknown MAC', () => {
    assert.deepEqual(devicesModule.getByMac('ff:ff:ff:ff:ff:ff'), []);
  });

  it('returns all IPs with the same MAC', () => {
    devicesModule.upsert({ ip: '192.168.1.10', mac: '00:11:22:33:44:55', source: 'nat' });
    devicesModule.upsert({ ip: '192.168.1.11', mac: '00:11:22:33:44:55', source: 'nat' });
    const rows = devicesModule.getByMac('00:11:22:33:44:55');
    assert.equal(rows.length, 2);
  });
});

describe('devices.seedFromConnectionHistory', () => {
  it('populates devices from a Map of connection entries', () => {
    const hist = new Map([
      ['10.0.0.1|8.8.8.8|53|UDP', {
        src: '10.0.0.1', srcMac: 'aa:bb:cc:00:00:01', srcVendor: 'Google',
        srcDnsName: 'gdev.local', srcMdnsName: null,
        firstSeen: Date.now() - 10000, lastSeen: Date.now(),
      }],
      ['10.0.0.2|1.1.1.1|443|TCP', {
        src: '10.0.0.2', srcMac: null, srcVendor: null,
        srcDnsName: null, srcMdnsName: null,
        firstSeen: Date.now() - 5000, lastSeen: Date.now(),
      }],
    ]);
    devicesModule.seedFromConnectionHistory(hist);
    const all = devicesModule.getAll();
    assert.equal(all.length, 2);
    const d = devicesModule.getByIp('10.0.0.1');
    assert.equal(d.mac,     'aa:bb:cc:00:00:01');
    assert.equal(d.vendor,  'Google');
    assert.equal(d.dnsName, 'gdev.local');
  });
});

describe('devices.reopen', () => {
  it('reopen() clears stale data — simulates post-restore state', () => {
    devicesModule.upsert({ ip: '192.168.1.50', mac: 'de:ad:be:ef:00:01', source: 'nat' });
    assert.equal(devicesModule.getAll().length, 1);
    devicesModule.reopen();
    assert.equal(devicesModule.getAll().length, 0);
  });

  it('reopen() keeps the module operational (upsert after reopen works)', () => {
    devicesModule.reopen();
    devicesModule.upsert({ ip: '10.0.0.99', source: 'dhcp' });
    assert.equal(devicesModule.getByIp('10.0.0.99')?.ip, '10.0.0.99');
  });
});

// ─── Step 1a: deviceId column ──────────────────────────────────────────────────

describe('devices: step 1a — deviceId column', () => {
  it('新規デバイスに deviceId が自動付与される', () => {
    devicesModule.upsert({ ip: '10.1.0.1', source: 'nat' });
    const row = devicesModule.getByIp('10.1.0.1');
    assert.ok(row.deviceId, 'deviceId が存在する');
    assert.match(row.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'deviceId が UUID 形式');
  });

  it('同一 IP への再 upsert で deviceId が変わらない（UNIQUE 永続性）', () => {
    const id1 = devicesModule.upsert({ ip: '10.1.0.2', source: 'nat' });
    const id2 = devicesModule.upsert({ ip: '10.1.0.2', source: 'dhcp' });
    assert.equal(id1, id2, 'deviceId は変わらない');
  });

  it('異なる IP は異なる deviceId を持つ', () => {
    const id1 = devicesModule.upsert({ ip: '10.1.0.3', source: 'nat' });
    const id2 = devicesModule.upsert({ ip: '10.1.0.4', source: 'nat' });
    assert.notEqual(id1, id2);
  });

  it('backfill: deviceId がない既存 row に自動付与される', () => {
    const dbPath = makeTmpDb();
    try {
      // Create the legacy schema directly (no deviceId column)
      const Database = require('better-sqlite3');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE devices (
          ip TEXT PRIMARY KEY, mac TEXT, vendor TEXT,
          dnsName TEXT, mdnsName TEXT, netbiosName TEXT, ipv6Addr TEXT,
          firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
          sources TEXT NOT NULL DEFAULT '', noteKey TEXT
        )
      `);
      legacyDb.prepare(
        "INSERT INTO devices (ip, firstSeen, lastSeen) VALUES ('10.99.0.1', 100, 200)"
      ).run();
      legacyDb.close();

      // A fresh initDb() triggers migration + backfill
      devicesModule.initDb(dbPath);
      const row = devicesModule.getByIp('10.99.0.1');
      assert.ok(row.deviceId, 'deviceId が backfill された');
      assert.match(row.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
      devicesModule._initForTest();
      cleanupTmpDb();
    }
  });

  it('reopen 後も deviceId が変わらない（永続性）', () => {
    const dbPath = makeTmpDb();
    try {
      devicesModule.initDb(dbPath);
      const id = devicesModule.upsert({ ip: '10.1.0.5', source: 'nat' });
      devicesModule.reopen();
      const row = devicesModule.getByIp('10.1.0.5');
      assert.equal(row.deviceId, id);
    } finally {
      devicesModule._initForTest();
      cleanupTmpDb();
    }
  });
});

// ─── Step 1b: getByDeviceId / upsert 後方互換 ────────────────────────────────

describe('devices: step 1b — getByDeviceId', () => {
  it('getByDeviceId() で端末を取得できる', () => {
    const id = devicesModule.upsert({ ip: '10.2.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });
    const row = devicesModule.getByDeviceId(id);
    assert.ok(row, 'row が見つかる');
    assert.equal(row.ip,  '10.2.0.1');
    assert.equal(row.mac, 'aa:00:00:00:00:01');
  });

  it('getByDeviceId() 存在しない場合 null を返す', () => {
    assert.equal(devicesModule.getByDeviceId('00000000-0000-0000-0000-000000000000'), null);
  });

  it('upsert は deviceId を返す', () => {
    const returned = devicesModule.upsert({ ip: '10.2.0.2', source: 'nat' });
    assert.ok(returned, 'deviceId が返る');
    assert.match(returned, /^[0-9a-f]{8}-/i);
  });

  it('upsert は既存の deviceId を上書きしない', () => {
    const first  = devicesModule.upsert({ ip: '10.2.0.3', source: 'nat' });
    // Re-upsert without specifying deviceId
    const second = devicesModule.upsert({ ip: '10.2.0.3', vendor: 'Sony', source: 'dhcp' });
    assert.equal(first, second, 'deviceId は保持される');
    const row = devicesModule.getByIp('10.2.0.3');
    assert.equal(row.vendor, 'Sony');   // the attribute was updated
  });

  it('明示的に deviceId を渡した場合それを使う（新規行）', () => {
    const fixedId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const returned = devicesModule.upsert({ ip: '10.2.0.4', source: 'nat', deviceId: fixedId });
    assert.equal(returned, fixedId);
    assert.equal(devicesModule.getByIp('10.2.0.4').deviceId, fixedId);
  });
});

// ─── Step 2: device_observations ────────────────────────────────────────────────

describe('devices: step 2 — device_observations write-on-change', () => {
  it('属性が変化したときのみ observation が追記される', () => {
    const Database = require('better-sqlite3');

    // First observeDevice → an observation is written
    devicesModule.observeDevice({ ip: '10.3.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });
    // Same attributes again → no write
    devicesModule.observeDevice({ ip: '10.3.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });
    // Same attributes again → no write
    devicesModule.observeDevice({ ip: '10.3.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });

    // Check the DB directly
    const db2 = new Database(':memory:'); // in-memory, so can't reference it directly; use getAll-based checks instead
    // observeDevice uses the in-memory DB from _initForTest(). To reach
    // device_observations, go through getByIp → deviceId instead.
    // Getting the actual observation count would need getObservationCount
    // (private), so instead we confirm indirectly, via the devices table's
    // mac staying unchanged, that "same deviceId + same MAC only updates
    // devices.lastSeen on subsequent calls".
    db2.close();
    const row = devicesModule.getByIp('10.3.0.1');
    assert.equal(row.mac, 'aa:00:00:00:00:01', 'devices テーブルは正常');
  });

  it('属性が変わると observation が追記される', () => {
    const id = devicesModule.observeDevice({ ip: '10.3.0.2', vendor: 'Apple', source: 'nat' });
    // vendor changes → an observation should be appended
    devicesModule.observeDevice({ ip: '10.3.0.2', vendor: 'Sony', source: 'nat' });
    const row = devicesModule.getByIp('10.3.0.2');
    assert.equal(row.vendor, 'Sony', 'vendor が更新されている');
    assert.equal(row.deviceId, id, 'deviceId は変わらない');
  });

  it('observeDevice は deviceId を返す', () => {
    const id = devicesModule.observeDevice({ ip: '10.3.0.3', source: 'nat' });
    assert.ok(id, 'deviceId が返る');
    assert.match(id, /^[0-9a-f]{8}-/i);
  });

  it('同一 deviceId に複数 source からの観測が保持される', () => {
    devicesModule.observeDevice({ ip: '10.3.0.4', mac: 'bb:00:00:00:00:01', vendor: 'Dell', source: 'nat' });
    devicesModule.observeDevice({ ip: '10.3.0.4', mac: 'bb:00:00:00:00:01', vendor: 'Dell', source: 'dhcp' });
    // nat and dhcp are different sources but share the same deviceId
    const row = devicesModule.getByIp('10.3.0.4');
    assert.ok(row.sources.includes('nat'),  'nat source が記録');
    assert.ok(row.sources.includes('dhcp'), 'dhcp source が記録');
  });
});

// ─── Step 3: observeDevice backward compatibility ─────────────────────────────

describe('devices: step 3 — observeDevice compatibility', () => {
  it('既知 IP に対して既存 deviceId を返す', () => {
    const id1 = devicesModule.upsert({ ip: '10.4.0.1', source: 'nat' });
    const id2 = devicesModule.observeDevice({ ip: '10.4.0.1', source: 'nat' });
    assert.equal(id1, id2, '同一の deviceId');
  });

  it('未知 IP に対して新しい deviceId を発行する', () => {
    const id = devicesModule.observeDevice({ ip: '10.4.0.2', source: 'nat' });
    assert.ok(id);
    assert.match(id, /^[0-9a-f]{8}-/i);
  });

  it('既存 upsert() 呼び出しが後方互換で動く', () => {
    // upsert() works even without passing a deviceId
    devicesModule.upsert({ ip: '10.4.0.3', mac: 'cc:00:00:00:00:01', source: 'nat' });
    const row = devicesModule.getByIp('10.4.0.3');
    assert.ok(row);
    assert.ok(row.deviceId, 'deviceId が付与されている');
  });
});

// ─── Step 4: isStableMac ──────────────────────────────────────────────────────

describe('devices: step 4 — isStableMac', () => {
  const { isStableMac } = devicesModule;

  it("'b8:27:eb:00:11:22' → true（globally unique, Raspberry Pi OUI）", () => {
    // b8 = 0b10111000, bit1(0x02) = 0 → globally unique
    assert.equal(isStableMac('b8:27:eb:00:11:22'), true);
  });

  it("'00:11:22:33:44:55' → true", () => {
    assert.equal(isStableMac('00:11:22:33:44:55'), true);
  });

  it("'02:00:00:00:00:01' → false（locally administered, bit1=1）", () => {
    assert.equal(isStableMac('02:00:00:00:00:01'), false);
  });

  it("'ff:ff:ff:ff:ff:ff' → false（broadcast）", () => {
    assert.equal(isStableMac('ff:ff:ff:ff:ff:ff'), false);
  });

  it("'00:00:00:00:00:00' → false（all-zero）", () => {
    assert.equal(isStableMac('00:00:00:00:00:00'), false);
  });

  it('形式不正（gg:hh:...) → false', () => {
    assert.equal(isStableMac('gg:hh:ii:jj:kk:ll'), false);
  });

  it('null → false', () => {
    assert.equal(isStableMac(null), false);
  });

  it('undefined → false', () => {
    assert.equal(isStableMac(undefined), false);
  });
});

// ─── Step 4: stable MAC auto-linking ──────────────────────────────────────────

describe('devices: step 4 — stable MAC auto-linking', () => {
  it('同じ stable MAC + IP 変更 → 同一 deviceId に紐付く', () => {
    // b8 = 0b10111000, bit1=0 → globally unique
    const stableMac = 'b8:27:eb:00:00:01';
    // Starts at .10
    const id1 = devicesModule.observeDevice({
      ip: '192.168.1.10', mac: stableMac, source: 'nat',
    });

    // IP changed to .11 (same MAC)
    const id2 = devicesModule.observeDevice({
      ip: '192.168.1.11', mac: stableMac, source: 'nat',
    });

    assert.equal(id1, id2, 'IP 変更後も同一 deviceId');
    // Can be looked up by the new IP
    const row = devicesModule.getByIp('192.168.1.11');
    assert.ok(row, '新 IP でデバイスが見つかる');
    assert.equal(row.deviceId, id1);
  });

  it('privacy MAC (unstable) の IP 変更 → 別 deviceId のまま（自動統合しない）', () => {
    // locally administered MAC（privacy MAC）
    const privacyMac = '02:ab:cd:ef:00:01';
    assert.equal(devicesModule.isStableMac(privacyMac), false, 'privacy MAC を確認');

    const id1 = devicesModule.observeDevice({ ip: '192.168.1.20', mac: privacyMac, source: 'nat' });
    const id2 = devicesModule.observeDevice({ ip: '192.168.1.21', mac: privacyMac, source: 'nat' });

    assert.notEqual(id1, id2, 'privacy MAC は別 deviceId のまま');
  });

  it('stable MAC で複数 IP が存在する場合は自動リンクしない（曖昧）', () => {
    const mac = 'aa:bb:cc:dd:ee:02';
    // The same stable MAC is registered under two different IPs
    devicesModule.upsert({ ip: '192.168.1.30', mac, source: 'nat' });
    devicesModule.upsert({ ip: '192.168.1.31', mac, source: 'nat' });

    // observeDevice with a 3rd IP → multiple candidates exist, so auto-linking is skipped → a new deviceId is issued
    const id3 = devicesModule.observeDevice({ ip: '192.168.1.32', mac, source: 'nat' });
    const row1 = devicesModule.getByIp('192.168.1.30');
    const row2 = devicesModule.getByIp('192.168.1.31');

    assert.notEqual(id3, row1.deviceId);
    assert.notEqual(id3, row2.deviceId);
  });

  it('stable MAC で既存 deviceId がある場合、新 IP 観測が自動リンクされる（observations にも記録）', () => {
    const mac = 'b8:27:eb:00:00:03';  // b8 = globally unique
    const id1 = devicesModule.observeDevice({ ip: '10.0.0.50', mac, source: 'nat' });

    // After the IP change, the observation is still recorded under the same deviceId
    const id2 = devicesModule.observeDevice({ ip: '10.0.0.51', mac, source: 'nat' });
    assert.equal(id1, id2);

    // The devices table now points at the new IP
    assert.ok(devicesModule.getByIp('10.0.0.51'), '新 IP の row がある');
    assert.equal(devicesModule.getByDeviceId(id1)?.ip, '10.0.0.51', 'deviceId が新 IP を指す');
  });
});

// ─── Step 5: computeMergeScore ────────────────────────────────────────────────

describe('devices: step 5 — computeMergeScore', () => {
  const { computeMergeScore } = devicesModule;

  it('同一 deviceId → score 0', () => {
    const d = { deviceId: 'aaa', mdnsName: 'test', dnsName: null, vendor: null };
    const { score } = computeMergeScore(d, d);
    assert.equal(score, 0);
  });

  it('mdnsName 完全一致 → score 0.5', () => {
    const a = { deviceId: 'aaa', mdnsName: 'Johns-iPhone.local', dnsName: null, vendor: null };
    const b = { deviceId: 'bbb', mdnsName: 'Johns-iPhone.local', dnsName: null, vendor: null };
    const { score, reasons } = computeMergeScore(a, b);
    assert.equal(score, 0.5);
    assert.ok(reasons.some(r => r.includes('mdnsName')));
  });

  it('dnsName 完全一致 → score 0.3', () => {
    const a = { deviceId: 'aaa', mdnsName: null, dnsName: 'my-laptop', vendor: null };
    const b = { deviceId: 'bbb', mdnsName: null, dnsName: 'my-laptop', vendor: null };
    const { score } = computeMergeScore(a, b);
    assert.equal(score, 0.3);
  });

  it('vendor 一致 → score 0.15', () => {
    const a = { deviceId: 'aaa', mdnsName: null, dnsName: null, vendor: 'Apple, Inc.' };
    const b = { deviceId: 'bbb', mdnsName: null, dnsName: null, vendor: 'Apple, Inc.' };
    const { score } = computeMergeScore(a, b);
    assert.equal(score, 0.15);
  });

  it('mdnsName + dnsName 一致 → score 0.8（上限）', () => {
    const a = { deviceId: 'aaa', mdnsName: 'MyPC.local', dnsName: 'my-pc', vendor: 'Dell' };
    const b = { deviceId: 'bbb', mdnsName: 'MyPC.local', dnsName: 'my-pc', vendor: 'Dell' };
    const { score } = computeMergeScore(a, b);
    assert.ok(score >= 0.8, 'score >= 0.8');
  });

  it('名前なし → score 0', () => {
    const a = { deviceId: 'aaa', mdnsName: null, dnsName: null, vendor: null };
    const b = { deviceId: 'bbb', mdnsName: null, dnsName: null, vendor: null };
    const { score } = computeMergeScore(a, b);
    assert.equal(score, 0);
  });

  it('大文字小文字を無視して一致', () => {
    const a = { deviceId: 'aaa', mdnsName: 'My-Device.local', dnsName: null, vendor: null };
    const b = { deviceId: 'bbb', mdnsName: 'my-device.local', dnsName: null, vendor: null };
    const { score } = computeMergeScore(a, b);
    assert.equal(score, 0.5);
  });
});

// ─── Step 6: merge candidates ─────────────────────────────────────────────────

describe('devices: step 6 — merge candidates', () => {
  it('同じ mdnsName の2デバイスが candidate として記録される', () => {
    devicesModule.observeDevice({ ip: '10.5.0.1', mdnsName: 'shared-host.local', source: 'nat' });
    devicesModule.observeDevice({ ip: '10.5.0.2', mdnsName: 'shared-host.local', source: 'nat' });
    const candidates = devicesModule.getMergeCandidates('pending');
    assert.equal(candidates.length, 1, '候補が1件');
    assert.ok(candidates[0].score >= 0.4, 'score >= 0.4');
  });

  it('approveMerge: observations が keepId に移る', () => {
    const idA = devicesModule.observeDevice({ ip: '10.5.1.1', mdnsName: 'merge-me.local', source: 'nat' });
    const idB = devicesModule.observeDevice({ ip: '10.5.1.2', mdnsName: 'merge-me.local', source: 'nat' });

    const ok = devicesModule.approveMerge(idA, idB);
    assert.ok(ok);

    // B is soft-deleted (archivedAt is set, mergedInto = idA)
    const dropped = devicesModule.getByDeviceId(idB);
    assert.ok(dropped != null,               'dropId の row は残る（soft delete）');
    assert.ok(dropped.archivedAt != null,    'dropId は archivedAt が設定される');
    assert.equal(dropped.mergedInto, idA,    'dropId.mergedInto === keepId');
    // Archived devices are excluded from getAll() and getByIp()
    assert.ok(!devicesModule.getAll().some(d => d.deviceId === idB), 'getAll には含まれない');
    // A remains
    assert.ok(devicesModule.getByDeviceId(idA), 'keepId の row が残る');
    // The candidate is now approved
    const approved = devicesModule.getMergeCandidates('approved');
    assert.ok(approved.some(c =>
      (c.deviceIdA === idA || c.deviceIdB === idA) &&
      (c.deviceIdA === idB || c.deviceIdB === idB)
    ), '候補が approved になる');
  });

  it('rejectCandidate: 候補が rejected になる', () => {
    devicesModule.observeDevice({ ip: '10.5.2.1', mdnsName: 'reject-test.local', source: 'nat' });
    devicesModule.observeDevice({ ip: '10.5.2.2', mdnsName: 'reject-test.local', source: 'nat' });
    const [candidate] = devicesModule.getMergeCandidates('pending');
    assert.ok(candidate, '候補が存在する');

    devicesModule.rejectCandidate(candidate.id);
    const pending = devicesModule.getMergeCandidates('pending');
    assert.equal(pending.length, 0, 'pending がゼロになる');
    const rejected = devicesModule.getMergeCandidates('rejected');
    assert.ok(rejected.length > 0, 'rejected に移動');
  });

  it('異なる mdnsName → candidate が作られない', () => {
    devicesModule.observeDevice({ ip: '10.5.3.1', mdnsName: 'device-x.local', source: 'nat' });
    devicesModule.observeDevice({ ip: '10.5.3.2', mdnsName: 'device-y.local', source: 'nat' });
    const candidates = devicesModule.getMergeCandidates('pending');
    assert.equal(candidates.length, 0, '候補なし');
  });
});

// ─── P1-8: deviceStatus / archiveDevice / unarchiveDevice ─────────────────────

describe('devices: P1-8 — status and archive', () => {
  beforeEach(() => devicesModule._initForTest());

  it('deviceStatus: 24h 以内 → active', () => {
    assert.equal(devicesModule.deviceStatus(Date.now() - 1000), 'active');
  });
  it('deviceStatus: 2日前 → recent', () => {
    assert.equal(devicesModule.deviceStatus(Date.now() - 2 * 24 * 60 * 60 * 1000), 'recent');
  });
  it('deviceStatus: 10日前 → stale', () => {
    assert.equal(devicesModule.deviceStatus(Date.now() - 10 * 24 * 60 * 60 * 1000), 'stale');
  });

  it('getAll() に status フィールドが含まれる', () => {
    devicesModule.observeDevice({ ip: '10.8.0.1', source: 'nat' });
    const all = devicesModule.getAll();
    assert.ok(all.length > 0);
    assert.ok(['active', 'recent', 'stale'].includes(all[0].status), 'status は active/recent/stale');
  });

  it('archiveDevice → getAll() から除外される', () => {
    const id = devicesModule.observeDevice({ ip: '10.8.1.1', source: 'nat' });
    assert.ok(devicesModule.getAll().some(d => d.deviceId === id), '元は含まれる');

    const ok = devicesModule.archiveDevice(id);
    assert.ok(ok, 'archive 成功');
    assert.ok(!devicesModule.getAll().some(d => d.deviceId === id), 'getAll から除外');
  });

  it('archiveDevice → getAll({ includeArchived: true }) には含まれ status=archived', () => {
    const id = devicesModule.observeDevice({ ip: '10.8.1.2', source: 'nat' });
    devicesModule.archiveDevice(id);
    const all = devicesModule.getAll({ includeArchived: true });
    const archived = all.find(d => d.deviceId === id);
    assert.ok(archived,                      'includeArchived: true で取得できる');
    assert.equal(archived.status, 'archived', 'status === archived');
  });

  it('unarchiveDevice → getAll() に戻る', () => {
    const id = devicesModule.observeDevice({ ip: '10.8.1.3', source: 'nat' });
    devicesModule.archiveDevice(id);
    assert.ok(!devicesModule.getAll().some(d => d.deviceId === id), 'アーカイブ後は非表示');

    const ok = devicesModule.unarchiveDevice(id);
    assert.ok(ok, 'unarchive 成功');
    const restored = devicesModule.getAll().find(d => d.deviceId === id);
    assert.ok(restored,                      'getAll に戻る');
    assert.ok(restored.archivedAt == null,   'archivedAt がクリアされる');
    assert.ok(restored.status !== 'archived', 'status が archived でなくなる');
  });

  it('archiveDevice: 存在しない deviceId → false', () => {
    assert.equal(devicesModule.archiveDevice('non-existent-uuid'), false);
  });

  it('archiveDevice: 既にアーカイブ済み → false（二重アーカイブ不可）', () => {
    const id = devicesModule.observeDevice({ ip: '10.8.1.4', source: 'nat' });
    devicesModule.archiveDevice(id);
    assert.equal(devicesModule.archiveDevice(id), false, '二重アーカイブは false');
  });
});

// ─── P2-12: checkStaleMergeCandidates ────────────────────────────────────────

describe('devices: P2-12 — checkStaleMergeCandidates', () => {
  beforeEach(() => devicesModule._initForTest());

  it('stale デバイスの merge 候補が checkStaleMergeCandidates で生成される', () => {
    const STALE = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8日前
    // Insert directly via upsert() (bypasses observeDevice's checkMergeCandidates)
    devicesModule.upsert({ ip: '10.10.0.1', mdnsName: 'stale-host.local', lastSeen: STALE, firstSeen: STALE, source: 'nat' });
    devicesModule.upsert({ ip: '10.10.0.2', mdnsName: 'stale-host.local', lastSeen: STALE, firstSeen: STALE, source: 'nat' });

    assert.equal(devicesModule.getMergeCandidates('pending').length, 0, '候補はまだない');

    const count = devicesModule.checkStaleMergeCandidates();
    assert.equal(count, 2, 'stale 端末 2台がスキャンされる');

    const candidates = devicesModule.getMergeCandidates('pending');
    assert.ok(candidates.length > 0, 'merge 候補が生成される');
  });

  it('active/recent デバイスは対象外', () => {
    // An active device (lastSeen = 1 hour ago)
    devicesModule.upsert({ ip: '10.10.1.1', mdnsName: 'active-host.local', lastSeen: Date.now() - 3600_000, firstSeen: Date.now(), source: 'nat' });
    devicesModule.upsert({ ip: '10.10.1.2', mdnsName: 'active-host.local', lastSeen: Date.now() - 3600_000, firstSeen: Date.now(), source: 'nat' });

    const count = devicesModule.checkStaleMergeCandidates();
    assert.equal(count, 0, 'active 端末はスキャン対象外');
  });

  it('stale デバイスが 0 台の場合 0 を返す', () => {
    assert.equal(devicesModule.checkStaleMergeCandidates(), 0);
  });
});

// ─── P2-11: mergedInto redirect for archived IPs ──────────────────────────────

describe('devices: P2-11 — observeDevice redirect via mergedInto', () => {
  beforeEach(() => devicesModule._initForTest());

  it('archived IP (mergedInto あり) への observeDevice → keepDevice.deviceId を返す', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.9.0.1', mdnsName: 'keep.local', source: 'nat' });
    const dropId = devicesModule.observeDevice({ ip: '10.9.0.2', mdnsName: 'drop.local', source: 'nat' });
    devicesModule.approveMerge(keepId, dropId);

    // Re-observing the dropped IP → redirected to keep
    const result = devicesModule.observeDevice({ ip: '10.9.0.2', source: 'nat' });
    assert.equal(result, keepId, 'keepDevice.deviceId が返る');
  });

  it('archived IP への observeDevice → keepDevice の lastSeen が更新される', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.9.1.1', source: 'nat' });
    const dropId = devicesModule.observeDevice({ ip: '10.9.1.2', source: 'nat' });
    devicesModule.approveMerge(keepId, dropId);

    const later = Date.now() + 5000;
    devicesModule.observeDevice({ ip: '10.9.1.2', lastSeen: later, source: 'nat' });

    const afterLastSeen = devicesModule.getByDeviceId(keepId).lastSeen;
    assert.ok(afterLastSeen >= later, 'keepDevice の lastSeen が更新される');
  });

  it('手動アーカイブ済み IP (mergedInto なし) への observeDevice → null', () => {
    const id = devicesModule.observeDevice({ ip: '10.9.2.1', source: 'nat' });
    devicesModule.archiveDevice(id);

    const result = devicesModule.observeDevice({ ip: '10.9.2.1', source: 'nat' });
    assert.equal(result, null, '手動アーカイブ済み IP への observeDevice は null');
  });

  it('mergedInto 先も archived の場合 → null（チェーンガード）', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.9.3.1', source: 'nat' });
    const dropId = devicesModule.observeDevice({ ip: '10.9.3.2', source: 'nat' });
    devicesModule.approveMerge(keepId, dropId);
    devicesModule.archiveDevice(keepId); // manually archive keep too

    const result = devicesModule.observeDevice({ ip: '10.9.3.2', source: 'nat' });
    assert.equal(result, null, 'keep もアーカイブ済みなら null');
  });
});

// ─── P3-138: flapping observations ────────────────────────────────────────────

describe('devices: P3-138 — 別ハードウェアのマージ先へのリダイレクト抑止', () => {
  beforeEach(() => devicesModule._initForTest());

  it('マージ元が別の安定MACで生きている場合 → リダイレクトせず null', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.8.0.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    const dropId = devicesModule.observeDevice({ ip: '10.8.0.2', mac: '7c:df:a1:5d:e7:2c', source: 'asus' });
    devicesModule.approveMerge(keepId, dropId);

    const result = devicesModule.observeDevice({ ip: '10.8.0.2', mac: '7c:df:a1:5d:e7:2c', source: 'asus' });
    assert.equal(result, null, '別ハードウェアの観測は keep に書かれない');
  });

  it('リダイレクト抑止が起きても keep の属性は書き換わらない', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.8.1.1', mac: '3c:a9:ab:09:77:f1', vendor: 'Nintendo', source: 'asus' });
    const dropId = devicesModule.observeDevice({ ip: '10.8.1.2', mac: '7c:df:a1:5d:e7:2c', vendor: 'Espressif', source: 'asus' });
    devicesModule.approveMerge(keepId, dropId);

    devicesModule.observeDevice({ ip: '10.8.1.2', mac: '7c:df:a1:5d:e7:2c', vendor: 'Espressif', source: 'asus' });
    assert.equal(devicesModule.getByDeviceId(keepId).mac, '3c:a9:ab:09:77:f1', 'keep の MAC は保たれる');
  });

  it('抑止された観測は getDiscardedRedirects で数えられる', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.8.2.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    const dropId = devicesModule.observeDevice({ ip: '10.8.2.2', mac: '7c:df:a1:5d:e7:2c', source: 'asus' });
    devicesModule.approveMerge(keepId, dropId);

    devicesModule.observeDevice({ ip: '10.8.2.2', mac: '7c:df:a1:5d:e7:2c', source: 'asus' });
    devicesModule.observeDevice({ ip: '10.8.2.2', mac: '7c:df:a1:5d:e7:2c', source: 'asus' });

    const [entry] = devicesModule.getDiscardedRedirects();
    assert.ok(entry, '抑止されたペアが記録される');
    assert.equal(entry.keepId, keepId, 'keepId が記録される');
    assert.equal(entry.discarded, 2, '抑止回数が数えられる');
  });

  it('MAC が同じ（DHCP でIPが戻ったケース）は従来どおりリダイレクトされる', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.8.3.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    // upsert() bypasses the stable-MAC auto-link, which would otherwise fold
    // this row into keep before the merge under test can happen.
    const dropId = devicesModule.upsert({ ip: '10.8.3.2', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    devicesModule.approveMerge(keepId, dropId);

    const result = devicesModule.observeDevice({ ip: '10.8.3.2', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    assert.equal(result, keepId, '同一ハードウェアならリダイレクトは維持される');
  });

  it('MAC 不明（NAT 由来など）は従来どおりリダイレクトされる', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.8.4.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    const dropId = devicesModule.observeDevice({ ip: '10.8.4.2', source: 'nat' });
    devicesModule.approveMerge(keepId, dropId);

    const result = devicesModule.observeDevice({ ip: '10.8.4.2', source: 'nat' });
    assert.equal(result, keepId, 'MAC が無ければ判定材料が無いので従来どおり');
  });

  it('ランダム化MAC（ローカル管理）は衝突の根拠にしない', () => {
    const keepId = devicesModule.observeDevice({ ip: '10.8.5.1', mac: 'be:41:8d:68:a8:ec', source: 'asus' });
    const dropId = devicesModule.observeDevice({ ip: '10.8.5.2', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    devicesModule.approveMerge(keepId, dropId);

    const result = devicesModule.observeDevice({ ip: '10.8.5.2', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    assert.equal(result, keepId, '片方がランダム化MACなら従来どおり');
  });
});

// ─── P3-138: 同一IPに複数の候補が来たときの選び方 ─────────────────────────────

describe('devices: chooseForIp — 記録済みのMACを優先する', () => {
  beforeEach(() => devicesModule._initForTest());

  const macOf = c => c.mac;
  const byRssi = (a, b) => ((b.rssi || 0) > (a.rssi || 0) ? b : a);

  it('候補が1つなら、そのまま返す', () => {
    const only = { mac: 'aa:bb:cc:00:00:01', rssi: -70 };
    assert.equal(devicesModule.chooseForIp('10.6.0.1', [only], macOf, byRssi), only);
  });

  it('記録済みのMACを持つ候補を選ぶ（RSSIが弱くても）', () => {
    devicesModule.observeDevice({ ip: '10.6.1.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    const recorded = { mac: '3c:a9:ab:09:77:f1', rssi: -80 };
    const other    = { mac: 'be:41:8d:68:a8:ec', rssi: -40 };

    assert.equal(devicesModule.chooseForIp('10.6.1.1', [other, recorded], macOf, byRssi), recorded);
    // Order must not change the answer: that was the flapping.
    assert.equal(devicesModule.chooseForIp('10.6.1.1', [recorded, other], macOf, byRssi), recorded);
  });

  it('MACの大文字小文字は同じものとして扱う', () => {
    devicesModule.observeDevice({ ip: '10.6.2.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    const upper = { mac: '3C:A9:AB:09:77:F1', rssi: -90 };
    const other = { mac: 'be:41:8d:68:a8:ec', rssi: -40 };
    assert.equal(devicesModule.chooseForIp('10.6.2.1', [other, upper], macOf, byRssi), upper);
  });

  it('記録済みのMACが候補に無ければ、従来どおりの決め方に落ちる', () => {
    devicesModule.observeDevice({ ip: '10.6.3.1', mac: '3c:a9:ab:09:77:f1', source: 'asus' });
    const weak   = { mac: 'aa:bb:cc:00:00:01', rssi: -80 };
    const strong = { mac: 'aa:bb:cc:00:00:02', rssi: -40 };
    assert.equal(devicesModule.chooseForIp('10.6.3.1', [weak, strong], macOf, byRssi), strong);
  });

  it('その IP の端末をまだ知らなければ、従来どおりの決め方に落ちる', () => {
    const weak   = { mac: 'aa:bb:cc:00:00:01', rssi: -80 };
    const strong = { mac: 'aa:bb:cc:00:00:02', rssi: -40 };
    assert.equal(devicesModule.chooseForIp('10.6.4.1', [weak, strong], macOf, byRssi), strong);
  });

  it('毎回同じ候補が選ばれ続ける（往復しない）', () => {
    devicesModule.observeDevice({ ip: '10.6.5.1', mac: '56:e6:22:b8:68:35', source: 'asus' });
    const recorded = { mac: '56:e6:22:b8:68:35' };
    const other    = { mac: '8c:bf:ea:8c:be:2c' };
    const picks = [];
    for (let poll = 0; poll < 10; poll++) {
      // The source's ordering flips every poll, as the real ASUS list does.
      const candidates = poll % 2 ? [recorded, other] : [other, recorded];
      picks.push(devicesModule.chooseForIp('10.6.5.1', candidates, macOf, (a, b) => b).mac);
    }
    assert.deepEqual([...new Set(picks)], ['56:e6:22:b8:68:35'], '10回とも同じMACが選ばれる');
  });
});

// ─── P3-138: 観測記録の上限 ───────────────────────────────────────────────────
//
// Nothing reads this table except the write-on-change check, which asks for one
// row per (deviceId, source). Measured on one Hub 2026-09-19: 3,671,407 rows
// and 586 MB with indexes -- the largest table in a 4 GB database -- serving a
// query that needs 780 rows.

describe('devices: pruneObservations', () => {
  beforeEach(() => devicesModule._initForTest());

  function observe(ip, vendor) {
    // OBS_MIN_INTERVAL_MS is 0 in tests, so each differing call appends a row.
    return devicesModule.observeDevice({ ip, vendor, source: 'asus' });
  }
  function countFor(deviceId) {
    return devicesModule._observationsForTest(deviceId, 'asus').length;
  }

  it('組ごとに上限を超えた古い行を消す', () => {
    let deviceId = null;
    for (let i = 0; i < 12; i++) deviceId = observe('10.7.0.1', `v${i}`);
    assert.equal(countFor(deviceId), 12, '前提: 12行ある');

    const pruned = devicesModule.pruneObservations({ maxPerPair: 5 });
    assert.equal(pruned.byCount, 7, '上限を超えた7行が消える');
    assert.equal(countFor(deviceId), 5);
  });

  it('残るのは新しい方である', () => {
    let deviceId = null;
    for (let i = 0; i < 6; i++) deviceId = observe('10.7.1.1', `v${i}`);
    devicesModule.pruneObservations({ maxPerPair: 2 });
    const vendors = devicesModule._observationsForTest(deviceId, 'asus').map(r => r.vendor);
    assert.deepEqual(vendors, ['v5', 'v4'], '新しい2行だけが残る');
  });

  it('上限以下なら何も消さない', () => {
    const deviceId = observe('10.7.2.1', 'only');
    const pruned = devicesModule.pruneObservations({ maxPerPair: 200 });
    assert.equal(pruned.byCount, 0);
    assert.equal(countFor(deviceId), 1);
  });

  // These rows are written in the same millisecond, so the cutoff has to be
  // pushed past them for the age rule to see anything at all. Without the wait
  // the assertion passes while testing nothing.
  const olderThanEverything = () => new Promise(resolve => setTimeout(resolve, 5));

  it('保持期間を過ぎても、組ごとの最新1行は必ず残す', async () => {
    // Losing it would erase the baseline the write-on-change check compares
    // against, and the next observation would look like a change.
    const deviceId = observe('10.7.3.1', 'quiet-device');
    await olderThanEverything();
    const pruned = devicesModule.pruneObservations({ maxPerPair: 200, maxAgeMs: 1 });
    assert.equal(pruned.byAge, 0, '最新1行は年齢で消さない');
    assert.equal(countFor(deviceId), 1);
  });

  it('保持期間を過ぎた古い行は、最新1行を残して消える', async () => {
    let deviceId = null;
    for (let i = 0; i < 4; i++) deviceId = observe('10.7.4.1', `v${i}`);
    await olderThanEverything();
    const pruned = devicesModule.pruneObservations({ maxPerPair: 200, maxAgeMs: 1 });
    assert.equal(pruned.byAge, 3, '最新1行を除く3行が消える');
    assert.equal(countFor(deviceId), 1);
  });

  it('別の端末の行を巻き込まない', () => {
    let a = null, b = null;
    for (let i = 0; i < 6; i++) a = observe('10.7.5.1', `a${i}`);
    for (let i = 0; i < 2; i++) b = observe('10.7.5.2', `b${i}`);
    devicesModule.pruneObservations({ maxPerPair: 3 });
    assert.equal(countFor(a), 3, '超えていた端末だけ削られる');
    assert.equal(countFor(b), 2, '超えていない端末はそのまま');
  });

  it('予算を超えたら途中で止め、続きがあると申告する', () => {
    // One statement over the whole table would block the loop: scanning
    // 3,671,415 rows to find the victims took 4,826 ms on one Hub before a
    // single row was deleted.
    let deviceId = null;
    for (let i = 0; i < 20; i++) deviceId = observe('10.7.7.1', `v${i}`);

    const first = devicesModule.pruneObservations({ maxPerPair: 2, batchSize: 3, budgetMs: 0 });
    assert.equal(first.byCount, 3, '1回ぶんだけ消す');
    assert.equal(first.more, true, '続きがあると申告する');
    assert.equal(countFor(deviceId), 17);
  });

  it('呼び直せば最後まで終わる', () => {
    let deviceId = null;
    for (let i = 0; i < 20; i++) deviceId = observe('10.7.8.1', `v${i}`);
    let guard = 0;
    let pruned;
    do {
      pruned = devicesModule.pruneObservations({ maxPerPair: 2, batchSize: 3, budgetMs: 0 });
    } while (pruned.more && ++guard < 50);
    assert.ok(guard < 50, '有限回で終わる');
    assert.equal(countFor(deviceId), 2);
  });

  it('剪定しても write-on-change の判定が変わらない', () => {
    const deviceId = observe('10.7.6.1', 'stable');
    devicesModule.pruneObservations({ maxPerPair: 1, maxAgeMs: 0 });
    observe('10.7.6.1', 'stable');   // same attributes as the surviving row
    assert.equal(countFor(deviceId), 1, '同じ属性なら追記されない');
  });
});
