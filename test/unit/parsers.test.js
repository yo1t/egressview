// Unit tests for parser functions
// Run: node --test test/unit/parsers.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─── Extract functions from server.js (no side-effects) ─────────────────────
// Since server.js doesn't export yet, we re-implement the pure functions here.
// After module split, these will import directly from src/ modules.

function parseNatDetail(text) {
  const sessions = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(TCP|UDP|ICMP|GRE)\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)/);
    if (!m) continue;
    const [, proto, srcRaw, dstRaw, ttl] = m;
    if (dstRaw.includes('*')) continue;
    const splitAddr = s => { const p = s.lastIndexOf('.'); return [s.slice(0, p), parseInt(s.slice(p + 1))]; };
    const [src, sport] = splitAddr(srcRaw);
    const [dst, dport] = splitAddr(dstRaw);
    if (!src.startsWith('192.168.') && !src.startsWith('10.')) continue;
    sessions.push({ proto, src, sport, dst, dport, ttl: parseInt(ttl) });
  }
  return sessions;
}

function parseOuiManuf(text) {
  const db = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const prefix = parts[0].trim();
    const fullName = (parts[2] || parts[1]).trim();
    if (!prefix || !fullName) continue;
    const hex = prefix.replace(/[:\-\.]/g, '');
    if (hex.length !== 6) continue;
    db.set(hex.toUpperCase(), fullName);
  }
  return db;
}

function isAllowedRouterIp(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1]), parseInt(m[2])];
  if (a > 255 || b > 255 || parseInt(m[3]) > 255 || parseInt(m[4]) > 255) return false;
  if (a === 169 && b === 254) return false;
  if (a === 127) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function parseClientList(raw) {
  const src = raw?.get_clientlist || raw;
  if (!src || typeof src !== 'object') return [];
  return Object.entries(src)
    .filter(([mac, info]) => mac !== 'maclist' && mac !== 'ClientAPILevel' && typeof info === 'object')
    .map(([mac, info]) => {
      const isWL = info.isWL;
      const connType = (isWL !== undefined && isWL !== null && isWL !== '')
        ? String(isWL) : String(info.type || '0');
      return {
        mac, ip: info.ip || '', name: info.nickName || info.name || mac,
        type: connType, isOnline: info.isOnline === '1' || info.isOnline === 1,
        rssi: parseInt(info.rssi || '0'),
        curRx: parseFloat(info.curRx || '0'), curTx: parseFloat(info.curTx || '0'),
        totalRx: parseInt(info.totalRx || '0'), totalTx: parseInt(info.totalTx || '0'),
        ipMethod: info.ipMethod || 'dhcp', internetMode: info.internetMode || 'allow',
        amesh_papMac: info.amesh_papMac || '', vendor: info.vendor || '',
      };
    })
    .filter(c => c.isOnline);
}

function computeRates(clients) {
  return clients.map(c => ({
    ...c,
    rxRate: (parseFloat(c.curRx) || 0) * 1024,
    txRate: (parseFloat(c.curTx) || 0) * 1024,
  }));
}

function inferVendorCategory(vendor) {
  if (!vendor) return null;
  const v = vendor.toLowerCase();
  if (v.includes('apple')) return { brand: 'Apple', category: 'Apple機器' };
  if (v.includes('amazon')) return { brand: 'Amazon', category: 'Amazon機器 (Echo/Fire TV/Kindle等)' };
  if (v.includes('google')) return { brand: 'Google', category: 'Google機器 (Nest/Chromecast/Pixel等)' };
  if (v.includes('sonos')) return { brand: 'Sonos', category: 'Sonos スピーカー' };
  if (v.includes('nintendo')) return { brand: 'Nintendo', category: 'Nintendo ゲーム機' };
  if (v.includes('sony')) return { brand: 'Sony', category: 'Sony 機器 (PlayStation/TV等)' };
  if (v.includes('raspberry pi')) return { brand: 'RasPi', category: 'Raspberry Pi' };
  if (v.includes('espressif')) return { brand: 'Espressif', category: 'ESP32/ESP8266 IoT機器' };
  return null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseNatDetail', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'nat-detail-sample.txt'), 'utf8');

  it('parses TCP sessions correctly', () => {
    const sessions = parseNatDetail(fixture);
    const tcp = sessions.filter(s => s.proto === 'TCP');
    assert(tcp.length >= 3, `Expected >=3 TCP sessions, got ${tcp.length}`);
  });

  it('parses UDP sessions correctly', () => {
    const sessions = parseNatDetail(fixture);
    const udp = sessions.filter(s => s.proto === 'UDP');
    assert(udp.length >= 1, `Expected >=1 UDP session, got ${udp.length}`);
  });

  it('parses ICMP sessions', () => {
    const sessions = parseNatDetail(fixture);
    const icmp = sessions.filter(s => s.proto === 'ICMP');
    assert.equal(icmp.length, 1);
  });

  it('parses GRE sessions from 10.x.x.x source', () => {
    const sessions = parseNatDetail(fixture);
    const gre = sessions.filter(s => s.proto === 'GRE');
    assert.equal(gre.length, 1);
    assert.equal(gre[0].src, '10.0.0.5');
    assert.equal(gre[0].sport, 0);
  });

  it('skips wildcard destinations', () => {
    const sessions = parseNatDetail(fixture);
    const wildcard = sessions.filter(s => s.dst.includes('*'));
    assert.equal(wildcard.length, 0);
  });

  it('skips non-private source addresses', () => {
    const sessions = parseNatDetail(fixture);
    const nonPrivate = sessions.filter(s =>
      !s.src.startsWith('192.168.') && !s.src.startsWith('10.')
    );
    assert.equal(nonPrivate.length, 0);
  });

  it('extracts correct fields for a known session', () => {
    const sessions = parseNatDetail(fixture);
    const s = sessions.find(s => s.dst === '142.250.196.110');
    assert(s, 'Should find session to 142.250.196.110');
    assert.equal(s.proto, 'TCP');
    assert.equal(s.src, '192.168.1.10');
    assert.equal(s.sport, 52344);
    assert.equal(s.dport, 443);
    assert.equal(s.ttl, 600);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseNatDetail(''), []);
  });

  it('returns empty array for garbage input', () => {
    assert.deepEqual(parseNatDetail('some random text\nno valid lines'), []);
  });
});

describe('parseOuiManuf', () => {
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'oui-sample.txt'), 'utf8');

  it('parses OUI entries correctly', () => {
    const db = parseOuiManuf(fixture);
    assert(db.size >= 4, `Expected >=4 entries, got ${db.size}`);
  });

  it('looks up ASUS by prefix', () => {
    const db = parseOuiManuf(fixture);
    assert.equal(db.get('CC28AA'), 'ASUSTeK COMPUTER INC.');
  });

  it('looks up Apple by prefix', () => {
    const db = parseOuiManuf(fixture);
    assert.equal(db.get('A483E7'), 'Apple, Inc.');
  });

  it('skips comment lines', () => {
    const db = parseOuiManuf(fixture);
    // Should not have an entry starting with '#'
    for (const key of db.keys()) {
      assert(!key.startsWith('#'));
    }
  });

  it('returns empty map for empty input', () => {
    const db = parseOuiManuf('');
    assert.equal(db.size, 0);
  });
});

describe('isAllowedRouterIp', () => {
  it('allows 192.168.x.x', () => {
    assert.equal(isAllowedRouterIp('192.168.1.1'), true);
    assert.equal(isAllowedRouterIp('192.168.0.254'), true);
  });

  it('allows 10.x.x.x', () => {
    assert.equal(isAllowedRouterIp('10.0.0.1'), true);
    assert.equal(isAllowedRouterIp('10.255.255.1'), true);
  });

  it('allows 172.16-31.x.x', () => {
    assert.equal(isAllowedRouterIp('172.16.0.1'), true);
    assert.equal(isAllowedRouterIp('172.31.255.1'), true);
  });

  it('rejects public IPs', () => {
    assert.equal(isAllowedRouterIp('8.8.8.8'), false);
    assert.equal(isAllowedRouterIp('142.250.196.110'), false);
  });

  it('rejects link-local (169.254.x.x)', () => {
    assert.equal(isAllowedRouterIp('169.254.169.254'), false);
  });

  it('rejects loopback (127.x.x.x)', () => {
    assert.equal(isAllowedRouterIp('127.0.0.1'), false);
  });

  it('rejects 172.15.x.x and 172.32.x.x', () => {
    assert.equal(isAllowedRouterIp('172.15.0.1'), false);
    assert.equal(isAllowedRouterIp('172.32.0.1'), false);
  });

  it('rejects non-string input', () => {
    assert.equal(isAllowedRouterIp(null), false);
    assert.equal(isAllowedRouterIp(undefined), false);
    assert.equal(isAllowedRouterIp(12345), false);
  });

  it('rejects invalid IP formats', () => {
    assert.equal(isAllowedRouterIp(''), false);
    assert.equal(isAllowedRouterIp('not-an-ip'), false);
    assert.equal(isAllowedRouterIp('192.168.1.999'), false);
    assert.equal(isAllowedRouterIp('256.1.1.1'), false);
  });
});

describe('htmlEscape', () => {
  it('escapes HTML special characters', () => {
    assert.equal(htmlEscape('<script>alert("xss")</script>'),
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes ampersand', () => {
    assert.equal(htmlEscape('a&b'), 'a&amp;b');
  });

  it('escapes single quotes', () => {
    assert.equal(htmlEscape("it's"), 'it&#39;s');
  });

  it('handles empty string', () => {
    assert.equal(htmlEscape(''), '');
  });

  it('converts non-string to string', () => {
    assert.equal(htmlEscape(123), '123');
    assert.equal(htmlEscape(null), 'null');
  });
});

describe('parseClientList', () => {
  it('parses online clients from ASUS format', () => {
    const raw = {
      get_clientlist: {
        'AA:BB:CC:DD:EE:FF': {
          ip: '192.168.1.100', name: 'iPhone', isOnline: '1',
          isWL: '2', rssi: '-55', curRx: '100', curTx: '50',
          totalRx: '500000', totalTx: '200000',
        },
        '11:22:33:44:55:66': {
          ip: '192.168.1.101', name: 'Desktop', isOnline: '0',
          isWL: '0', rssi: '0', curRx: '0', curTx: '0',
          totalRx: '1000000', totalTx: '800000',
        },
        maclist: 'AA:BB:CC:DD:EE:FF,11:22:33:44:55:66',
        ClientAPILevel: '2',
      }
    };
    const clients = parseClientList(raw);
    assert.equal(clients.length, 1, 'Should only include online clients');
    assert.equal(clients[0].mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(clients[0].ip, '192.168.1.100');
    assert.equal(clients[0].type, '2');
    assert.equal(clients[0].rssi, -55);
  });

  it('returns empty array for null/undefined input', () => {
    assert.deepEqual(parseClientList(null), []);
    assert.deepEqual(parseClientList(undefined), []);
  });

  it('filters out maclist and ClientAPILevel keys', () => {
    const raw = {
      get_clientlist: {
        maclist: 'AA:BB:CC:DD:EE:FF',
        ClientAPILevel: '2',
        'AA:BB:CC:DD:EE:FF': { ip: '192.168.1.100', isOnline: '1', isWL: '1' },
      }
    };
    const clients = parseClientList(raw);
    assert.equal(clients.length, 1);
  });
});

describe('computeRates', () => {
  it('converts KB/s to B/s', () => {
    const clients = [{ curRx: '100', curTx: '50' }];
    const result = computeRates(clients);
    assert.equal(result[0].rxRate, 100 * 1024);
    assert.equal(result[0].txRate, 50 * 1024);
  });

  it('handles zero/missing values', () => {
    const clients = [{ curRx: '0', curTx: '' }];
    const result = computeRates(clients);
    assert.equal(result[0].rxRate, 0);
    assert.equal(result[0].txRate, 0);
  });
});

describe('inferVendorCategory', () => {
  it('identifies Apple devices', () => {
    const result = inferVendorCategory('Apple, Inc.');
    assert.equal(result.brand, 'Apple');
  });

  it('identifies Amazon devices', () => {
    const result = inferVendorCategory('Amazon Technologies Inc.');
    assert.equal(result.brand, 'Amazon');
  });

  it('identifies Raspberry Pi', () => {
    const result = inferVendorCategory('Raspberry Pi Trading Ltd');
    assert.equal(result.brand, 'RasPi');
  });

  it('returns null for unknown vendor', () => {
    assert.equal(inferVendorCategory('Unknown Vendor Corp'), null);
  });

  it('returns null for empty/null input', () => {
    assert.equal(inferVendorCategory(null), null);
    assert.equal(inferVendorCategory(''), null);
  });
});
