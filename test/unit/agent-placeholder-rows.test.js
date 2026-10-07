'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { createAgentPlaceholderRows } = require('../../src/agent-placeholder-rows');

const COLUMNS = `src TEXT, dst TEXT, dport INTEGER, proto TEXT, sport INTEGER, ttl INTEGER,
  srcMac TEXT, srcVendor TEXT, srcDnsName TEXT, srcMdnsName TEXT, dstHost TEXT, country TEXT,
  org TEXT, lat REAL, lon REAL, city TEXT, firstSeen INTEGER, lastSeen INTEGER,
  agentHost TEXT, process TEXT, pid INTEGER`;

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE connections (${COLUMNS}, PRIMARY KEY (src, dst, dport, proto));
    CREATE TABLE connection_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, routerId TEXT,
      firstObservedAt INTEGER, lastObservedAt INTEGER, PRIMARY KEY (src, dst, dport, proto, routerId));
    CREATE TABLE agents (agentId TEXT PRIMARY KEY, hostName TEXT);
    CREATE TABLE agent_observations (
      agentId TEXT, observationId TEXT, localAddress TEXT, localPort INTEGER,
      remoteAddress TEXT, remotePort INTEGER, networkProtocol TEXT, lastObservedAt INTEGER);
    CREATE TABLE connection_agent_observations (
      src TEXT, dst TEXT, dport INTEGER, proto TEXT, agentId TEXT, observationId TEXT, matchKind TEXT);
    INSERT INTO agents VALUES ('agent-a', 'mac-1');
  `);
  const cache = new Map();
  const rows = createAgentPlaceholderRows({ getDb: () => db, cache });
  const addRow = (src, dst, dport, proto, firstSeen, lastSeen, extra = {}) => {
    db.prepare(`INSERT INTO connections (src, dst, dport, proto, firstSeen, lastSeen, agentHost, process, dstHost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(src, dst, dport, proto, firstSeen, lastSeen,
      extra.agentHost ?? 'mac-1', extra.process ?? 'mDNSResponder', extra.dstHost ?? null);
    cache.set(`${src}|${dst}|${dport}|${proto}`, { src, dst, dport, proto, firstSeen, lastSeen, agentHost: 'mac-1', observedBy: [] });
  };
  const row = (src, dst, dport, proto) => db.prepare(
    'SELECT * FROM connections WHERE src = ? AND dst = ? AND dport = ? AND proto = ?').get(src, dst, dport, proto);
  return { db, cache, rows, addRow, row };
}

describe('agent placeholder rows (P3-185)', () => {
  it('送信元が分かったら、行を本当の送信元へ移し、0.0.0.0の行は消す', () => {
    const { db, cache, rows, addRow, row } = fixture();
    addRow('0.0.0.0', '192.0.2.36', 5353, 'udp', 1000, 2000, { dstHost: 'printer.local' });
    cache.get('0.0.0.0|192.0.2.36|5353|udp').lastSeen = 2500; // newer in memory than in the table
    db.prepare('INSERT INTO connection_agent_observations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('0.0.0.0', '192.0.2.36', 5353, 'UDP', 'agent-a', 'obs-1', 'exact');

    const outcome = rows.relocate({ fromSrc: '0.0.0.0', toSrc: '192.0.2.34', toSport: 5353, dst: '192.0.2.36', dport: 5353, proto: 'udp', agentHost: 'mac-1' });

    assert.deepEqual(outcome, { firstSeen: 1000, lastSeen: 2500, merged: false, placeholderRemoved: true });
    assert.equal(row('0.0.0.0', '192.0.2.36', 5353, 'udp'), undefined);
    const moved = row('192.0.2.34', '192.0.2.36', 5353, 'udp');
    assert.equal(moved.sport, 5353);
    assert.equal(moved.dstHost, 'printer.local');
    assert.equal(moved.lastSeen, 2500);
    assert.equal(cache.has('0.0.0.0|192.0.2.36|5353|udp'), false, 'the snapshot must not write it back');
    assert.equal(cache.get('192.0.2.34|192.0.2.36|5353|udp').src, '192.0.2.34');
    assert.equal(db.prepare('SELECT src FROM connection_agent_observations').get().src, '192.0.2.34');
  });

  it('本当の送信元の行がすでにあれば、時刻をまとめる', () => {
    const { cache, rows, addRow, row } = fixture();
    addRow('::', 'fe80::1', 5353, 'udp', 500, 900);
    addRow('fe80::9', 'fe80::1', 5353, 'udp', 800, 3000);

    const outcome = rows.relocate({ fromSrc: '::', toSrc: 'fe80::9', dst: 'fe80::1', dport: 5353, proto: 'udp', agentHost: 'mac-1' });

    assert.equal(outcome.merged, true);
    assert.equal(row('fe80::9', 'fe80::1', 5353, 'udp').firstSeen, 500);
    assert.equal(row('fe80::9', 'fe80::1', 5353, 'udp').lastSeen, 3000);
    assert.equal(cache.get('fe80::9|fe80::1|5353|udp').firstSeen, 500);
    assert.equal(row('::', 'fe80::1', 5353, 'udp'), undefined);
  });

  it('ほかの観測がまだ0.0.0.0を使っていれば、0.0.0.0の行は残す', () => {
    const { db, cache, rows, addRow, row } = fixture();
    addRow('0.0.0.0', '224.0.0.251', 5353, 'udp', 1000, 2000);
    db.prepare('INSERT INTO agent_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('agent-a', 'obs-2', '0.0.0.0', 5353, '224.0.0.251', 5353, 'udp', 2000);

    const outcome = rows.relocate({ fromSrc: '0.0.0.0', toSrc: '192.0.2.34', dst: '224.0.0.251', dport: 5353, proto: 'udp', agentHost: 'mac-1' });

    assert.equal(outcome.placeholderRemoved, false);
    assert.ok(row('0.0.0.0', '224.0.0.251', 5353, 'udp'));
    assert.ok(row('192.0.2.34', '224.0.0.251', 5353, 'udp'));
    assert.ok(cache.has('0.0.0.0|224.0.0.251|5353|udp'));
  });

  // P2-102: any enrolled agent can report any address, but only the agent
  // whose flow it is may move the row.
  it('ほかのAgentの行は動かさない', () => {
    const { rows, addRow, row } = fixture();
    addRow('0.0.0.0', '192.0.2.36', 5353, 'udp', 1000, 2000);
    assert.equal(rows.relocate({ fromSrc: '0.0.0.0', toSrc: '192.0.2.99', dst: '192.0.2.36', dport: 5353, proto: 'udp', agentHost: 'other-mac' }), null);
    assert.equal(rows.relocate({ fromSrc: '0.0.0.0', toSrc: '192.0.2.99', dst: '192.0.2.36', dport: 5353, proto: 'udp' }), null);
    assert.ok(row('0.0.0.0', '192.0.2.36', 5353, 'udp'));
    assert.equal(row('192.0.2.99', '192.0.2.36', 5353, 'udp'), undefined);
  });

  it('ルーターが見た行や、送信元が分からないままの付け替えには手を付けない', () => {
    const { db, rows, addRow, row } = fixture();
    addRow('0.0.0.0', '198.51.100.1', 443, 'udp', 1, 2);
    db.prepare('INSERT INTO connection_observations VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('0.0.0.0', '198.51.100.1', 443, 'udp', 'yamaha1', 1, 2);
    assert.equal(rows.relocate({ fromSrc: '0.0.0.0', toSrc: '192.0.2.34', dst: '198.51.100.1', dport: 443, proto: 'udp', agentHost: 'mac-1' }), null);
    assert.ok(row('0.0.0.0', '198.51.100.1', 443, 'udp'));
    assert.equal(rows.relocate({ fromSrc: '192.0.2.34', toSrc: '192.0.2.35', dst: '198.51.100.1', dport: 443, proto: 'udp', agentHost: 'mac-1' }), null);
    assert.equal(rows.relocate({ fromSrc: '0.0.0.0', toSrc: '::', dst: '198.51.100.1', dport: 443, proto: 'udp', agentHost: 'mac-1' }), null);
  });
});
