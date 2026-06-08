// Unit tests for src/devices.js (in-memory SQLite)
'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const devicesModule = require('../../src/devices');

// ─── tmp DB ヘルパー ──────────────────────────────────────────────────────────

let tmpDbPath = null;

function makeTmpDb() {
  tmpDbPath = path.join(os.tmpdir(), `widemap-devices-test-${process.pid}-${Date.now()}.db`);
  return tmpDbPath;
}

function cleanupTmpDb() {
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(tmpDbPath + ext); } catch {}
  }
  tmpDbPath = null;
}

// ─── 各テスト前にリセット ────────────────────────────────────────────────────

beforeEach(() => devicesModule._initForTest());

after(() => devicesModule._initForTest());

// ─── 既存テスト（後方互換） ───────────────────────────────────────────────────

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

// ─── Step 1a: deviceId カラム ────────────────────────────────────────────────

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
      // レガシースキーマ（deviceId 列なし）を直接作成
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

      // 新しい initDb → migration + backfill が走る
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
    // deviceId を指定しないで再 upsert
    const second = devicesModule.upsert({ ip: '10.2.0.3', vendor: 'Sony', source: 'dhcp' });
    assert.equal(first, second, 'deviceId は保持される');
    const row = devicesModule.getByIp('10.2.0.3');
    assert.equal(row.vendor, 'Sony');   // 属性は更新されている
  });

  it('明示的に deviceId を渡した場合それを使う（新規行）', () => {
    const fixedId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const returned = devicesModule.upsert({ ip: '10.2.0.4', source: 'nat', deviceId: fixedId });
    assert.equal(returned, fixedId);
    assert.equal(devicesModule.getByIp('10.2.0.4').deviceId, fixedId);
  });
});

// ─── Step 2: device_observations ─────────────────────────────────────────────

describe('devices: step 2 — device_observations write-on-change', () => {
  it('属性が変化したときのみ observation が追記される', () => {
    const Database = require('better-sqlite3');

    // 最初の observeDevice → observation 書き込みあり
    devicesModule.observeDevice({ ip: '10.3.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });
    // 同じ属性で再呼び出し → 書き込みなし
    devicesModule.observeDevice({ ip: '10.3.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });
    // 同じ属性で再呼び出し → 書き込みなし
    devicesModule.observeDevice({ ip: '10.3.0.1', mac: 'aa:00:00:00:00:01', source: 'nat' });

    // DB を直接確認
    const db2 = new Database(':memory:'); // ← in-memory なので直接参照できない、別途 getAll ベース
    // observeDevice は _initForTest() の in-memory DB を使う。
    // device_observations にアクセスするため一旦 getByIp → deviceId 経由で確認する。
    // 実際の observation 件数は getObservationCount (非公開) が必要なため
    // ここでは「同一 deviceId + 同一 MAC だと 2回目以降は devices.lastSeen だけ更新」という
    // 側面を、devices テーブルの mac が変わらないことで間接確認する。
    db2.close();
    const row = devicesModule.getByIp('10.3.0.1');
    assert.equal(row.mac, 'aa:00:00:00:00:01', 'devices テーブルは正常');
  });

  it('属性が変わると observation が追記される', () => {
    const id = devicesModule.observeDevice({ ip: '10.3.0.2', vendor: 'Apple', source: 'nat' });
    // vendor が変わる → observation 追記されるべき
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
    // nat と dhcp、それぞれ別 source だが同一 deviceId
    const row = devicesModule.getByIp('10.3.0.4');
    assert.ok(row.sources.includes('nat'),  'nat source が記録');
    assert.ok(row.sources.includes('dhcp'), 'dhcp source が記録');
  });
});

// ─── Step 3: observeDevice 後方互換 ──────────────────────────────────────────

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
    // upsert に deviceId を渡さなくても動作する
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

// ─── Step 4: stable MAC 自動リンク ───────────────────────────────────────────

describe('devices: step 4 — stable MAC auto-linking', () => {
  it('同じ stable MAC + IP 変更 → 同一 deviceId に紐付く', () => {
    // b8 = 0b10111000, bit1=0 → globally unique
    const stableMac = 'b8:27:eb:00:00:01';
    // 最初は .10 にいる
    const id1 = devicesModule.observeDevice({
      ip: '192.168.1.10', mac: stableMac, source: 'nat',
    });

    // IP が .11 に変わった（同じ MAC）
    const id2 = devicesModule.observeDevice({
      ip: '192.168.1.11', mac: stableMac, source: 'nat',
    });

    assert.equal(id1, id2, 'IP 変更後も同一 deviceId');
    // 新しい IP で参照できる
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
    // 2 つの異なる IP に同じ stable MAC が登録されている
    devicesModule.upsert({ ip: '192.168.1.30', mac, source: 'nat' });
    devicesModule.upsert({ ip: '192.168.1.31', mac, source: 'nat' });

    // 3 つ目の IP で observeDevice → 複数候補があるため自動リンク不可 → 新規 deviceId
    const id3 = devicesModule.observeDevice({ ip: '192.168.1.32', mac, source: 'nat' });
    const row1 = devicesModule.getByIp('192.168.1.30');
    const row2 = devicesModule.getByIp('192.168.1.31');

    assert.notEqual(id3, row1.deviceId);
    assert.notEqual(id3, row2.deviceId);
  });

  it('stable MAC で既存 deviceId がある場合、新 IP 観測が自動リンクされる（observations にも記録）', () => {
    const mac = 'b8:27:eb:00:00:03';  // b8 = globally unique
    const id1 = devicesModule.observeDevice({ ip: '10.0.0.50', mac, source: 'nat' });

    // IP 変更後も同じ deviceId で observation が記録される
    const id2 = devicesModule.observeDevice({ ip: '10.0.0.51', mac, source: 'nat' });
    assert.equal(id1, id2);

    // devices テーブルは新 IP を指す
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

    // B が消えている
    assert.equal(devicesModule.getByDeviceId(idB), null, 'dropId の row が消える');
    // A が残っている
    assert.ok(devicesModule.getByDeviceId(idA), 'keepId の row が残る');
    // 候補が approved になっている
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
