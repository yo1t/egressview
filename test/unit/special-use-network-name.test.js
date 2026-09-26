'use strict';

// P3-174: the log names LAN, loopback and CGNAT destinations instead of
// leaving their country blank, and the country filter finds them. The name
// comes from the special-use list, in JavaScript for the rows the browser
// shows and as SQL text patterns for the filter; these hold the two together.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
  SPECIAL_USE_IPV4, SPECIAL_USE_IPV6, NETWORK_NAMES, networkName, networkNameSql, countryLikeSql,
} = require('../../src/special-use-address');

test('names exactly the ranges the backlog decided, and no others', () => {
  const named = [...SPECIAL_USE_IPV4, ...SPECIAL_USE_IPV6].filter(range => range[2])
    .map(([base, bits, name]) => `${base}/${bits}=${name}`).sort();
  assert.deepEqual(named, ['10.0.0.0/8=LAN', '100.64.0.0/10=CGNAT', '127.0.0.0/8=loopback',
    '169.254.0.0/16=LAN', '172.16.0.0/12=LAN', '192.168.0.0/16=LAN', '::1/128=loopback',
    'fc00::/7=LAN', 'fe80::/10=LAN'].sort());
  assert.deepEqual(NETWORK_NAMES, ['LAN', 'CGNAT', 'loopback']);
});

test('networkName answers inside, at the edges and just outside each range', () => {
  const cases = [
    ['10.0.0.1', 'LAN'], ['172.16.0.1', 'LAN'], ['172.31.255.255', 'LAN'], ['192.168.1.1', 'LAN'],
    ['169.254.169.254', 'LAN'], ['fd12:3456::1', 'LAN'], ['fc00::1', 'LAN'], ['fe80::1', 'LAN'],
    ['febf::1', 'LAN'], ['FE80::1', 'LAN'], ['::ffff:192.168.1.1', 'LAN'], ['[fe80::1]', 'LAN'],
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['::1', 'loopback'],
    ['100.64.0.1', 'CGNAT'], ['100.127.255.255', 'CGNAT'],
    ['100.63.255.255', null], ['100.128.0.0', null], ['172.32.0.1', null], ['172.15.255.255', null],
    ['192.169.0.1', null], ['8.8.8.8', null], ['2001:4860:4860::8888', null],
    ['224.0.0.251', null], ['ff02::fb', null], ['192.0.2.1', null], ['0.0.0.0', null], ['::', null],
    ['fec0::1', null], ['fd::1', null], ['', null], [null, null], ['example.com', null],
  ];
  for (const [address, name] of cases) assert.equal(networkName(address), name, String(address));
});

// Seeded, so a failure names addresses that fail again on the next run.
let seed = 0x5eed174;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randomOctet() { return Math.floor(random() * 256); }

test('the SQL form gives networkName\'s answer for addresses written the usual way', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE a (address TEXT)');
  const insert = db.prepare('INSERT INTO a VALUES (?)');
  const addresses = ['::1', '::', 'fc00::1', 'fdff:ffff::1', 'fe80::1', 'febf::1', 'FEBF::1', 'fec0::1',
    'fd::1', 'fe8::1', '::ffff:10.0.0.1', '::FFFF:172.20.1.1', '::ffff:8.8.8.8', '100.64.0.0',
    '100.127.255.255', '100.63.255.255', '100.128.0.0', '172.15.1.1', '172.16.1.1', '172.31.1.1',
    '172.32.1.1', '1.10.0.1', '110.0.0.1', '210.0.0.1', '192.168.0.0', '192.1.168.1'];
  for (let i = 0; i < 20000; i++) addresses.push([randomOctet(), randomOctet(), randomOctet(), randomOctet()].join('.'));
  for (let i = 0; i < 6000; i++) {
    const first = [10, 100, 127, 169, 172, 192][i % 6];
    addresses.push([first, randomOctet(), randomOctet(), randomOctet()].join('.'));
    addresses.push(`::ffff:${[first, randomOctet(), 1, 2].join('.')}`);
    // Never 0: "0::1" is ::1 written the unusual way, which the text
    // patterns do not claim to match. On CI it came up about once in ten runs.
    const group = (1 + Math.floor(random() * 65535)).toString(16);
    addresses.push(`${group}::1`, `${group.toUpperCase()}:0:1::2`);
  }
  db.transaction(() => { for (const address of addresses) insert.run(address); })();
  const rows = db.prepare(`SELECT address, ${networkNameSql('address', 'NULL')} AS name FROM a`).all();
  const disagreements = rows.filter(row => row.name !== networkName(row.address));
  assert.deepEqual(disagreements.slice(0, 5), [], `${disagreements.length} of ${rows.length} disagree`);
});

test('the country filter finds LAN, loopback and CGNAT, and a country filter does not', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE c (dst TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO c VALUES (?, ?)');
  const rows = [['192.168.1.1', null], ['10.1.2.3', ''], ['fe80::1', null], ['127.0.0.1', null],
    ['100.100.1.1', null], ['8.8.8.8', 'US'], ['1.1.1.1', 'AU'], ['2001:db8::1', null],
    // A LAN address carrying a country is shown as LAN, so it is found as LAN.
    ['192.168.9.9', 'US']];
  for (const row of rows) insert.run(...row);
  const find = (pattern) => {
    const { sql, params } = countryLikeSql('dst', 'country', pattern);
    return db.prepare(`SELECT dst FROM c WHERE ${sql} ORDER BY dst`).all(...params).map(row => row.dst);
  };
  assert.deepEqual(find('%LAN%'), ['10.1.2.3', '192.168.1.1', '192.168.9.9', 'fe80::1']);
  assert.deepEqual(find('lan'), ['10.1.2.3', '192.168.1.1', '192.168.9.9', 'fe80::1'], 'as case-blind as LIKE');
  assert.deepEqual(find('loopback'), ['127.0.0.1']);
  assert.deepEqual(find('CGNAT'), ['100.100.1.1']);
  assert.deepEqual(find('%US%'), ['8.8.8.8']);
  assert.deepEqual(find('A%'), ['1.1.1.1'], 'AU, but not the LAN rows whose country is blank');
  assert.deepEqual(find('%'), rows.filter(([, country]) => country != null).map(([dst]) => dst)
    .concat(['127.0.0.1', '100.100.1.1', '192.168.1.1', 'fe80::1']).filter((v, i, a) => a.indexOf(v) === i).sort(),
  'everything that shows anything');
  assert.deepEqual(find('L\\_N'), [], 'an escaped underscore is a literal underscore');
  assert.deepEqual(find('L_N'), ['10.1.2.3', '192.168.1.1', '192.168.9.9', 'fe80::1'], 'and a bare one any character');
});

test('the log filter goes by the shown country, whatever mode it is typed in', () => {
  const { buildFilterConditions } = require('../../src/history-queries');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE connections (dst TEXT, country TEXT)');
  const insert = db.prepare('INSERT INTO connections VALUES (?, ?)');
  for (const row of [['192.168.1.1', null], ['8.8.8.8', 'US'], ['100.64.1.1', null], ['1.1.1.1', 'AU']]) insert.run(...row);
  const find = (mode, value) => {
    const { conditions, params } = buildFilterConditions({ country: { mode, value } });
    return db.prepare(`SELECT dst FROM connections WHERE ${conditions.join(' AND ')} ORDER BY dst`)
      .all(...params).map(row => row.dst);
  };
  assert.deepEqual(find('contains', 'LAN'), ['192.168.1.1']);
  assert.deepEqual(find('exact', 'CGNAT'), ['100.64.1.1']);
  assert.deepEqual(find('startsWith', 'U'), ['8.8.8.8']);
  assert.deepEqual(find('endsWith', 'N'), ['192.168.1.1'], 'LAN ends in N; CGNAT does not');
  assert.deepEqual(find('contains', 'A'), ['1.1.1.1', '100.64.1.1', '192.168.1.1']);
});
