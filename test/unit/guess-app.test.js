// Unit tests for public/js/utils.js — guessApp()
// Run: node --test test/unit/guess-app.test.js
//
// guessApp is a frontend function with no module.exports.
// We load it into a vm context to test it in isolation.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

// Strip ES module import/export lines so the file can run in a VM classic-script context.
// export function/class/const/let/var declarations keep their body; only the 'export' keyword is removed.
function stripEsModule(src) {
  return src
    .replace(/^import\s[^;]+;?\s*$/gm, '')
    .replace(/^export\s+(default\s+)?(function|class|const|let|var)\s/gm, '$2 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}
const src = stripEsModule(fs.readFileSync(
  path.join(__dirname, '../../public/js/utils.js'), 'utf8'
));

// Provide the minimal browser globals the file uses at load time
const ctx = vm.createContext({ window: { BASE_URL: '' }, t: key => key });
vm.runInContext(src, ctx);
const { guessApp } = ctx;

// ─── UDP overrides ─────────────────────────────────────────────────────────────

describe('guessApp — UDP overrides', () => {
  it('443/UDP → QUIC (not HTTPS)', () =>
    assert.equal(guessApp(443, 'UDP', ''), 'QUIC'));

  it('80/UDP → QUIC (not HTTP)', () =>
    assert.equal(guessApp(80, 'UDP', ''), 'QUIC'));

  it('123/UDP → NTP', () =>
    assert.equal(guessApp(123, 'UDP', ''), 'NTP'));

  it('5353/UDP → mDNS', () =>
    assert.equal(guessApp(5353, 'UDP', ''), 'mDNS'));

  it('500/UDP → IPSec IKE', () =>
    assert.equal(guessApp(500, 'UDP', ''), 'IPSec IKE'));

  it('4500/UDP → IPSec/NAT', () =>
    assert.equal(guessApp(4500, 'UDP', ''), 'IPSec/NAT'));

  it('51820/UDP → WireGuard', () =>
    assert.equal(guessApp(51820, 'UDP', ''), 'WireGuard'));

  it('67/UDP → DHCP', () =>
    assert.equal(guessApp(67, 'UDP', ''), 'DHCP'));

  it('68/UDP → DHCP', () =>
    assert.equal(guessApp(68, 'UDP', ''), 'DHCP'));

  it('161/UDP → SNMP', () =>
    assert.equal(guessApp(161, 'UDP', ''), 'SNMP'));

  it('3544/UDP → Teredo', () =>
    assert.equal(guessApp(3544, 'UDP', ''), 'Teredo'));
});

// ─── TCP port-only matches ─────────────────────────────────────────────────────

describe('guessApp — TCP port-only', () => {
  it('22/TCP → SSH', () =>
    assert.equal(guessApp(22, 'TCP', ''), 'SSH'));

  it('53/TCP → DNS', () =>
    assert.equal(guessApp(53, 'TCP', ''), 'DNS'));

  it('443/TCP without host → HTTPS', () =>
    assert.equal(guessApp(443, 'TCP', ''), 'HTTPS'));

  it('80/TCP without host → HTTP', () =>
    assert.equal(guessApp(80, 'TCP', ''), 'HTTP'));

  it('5223/TCP → APNs', () =>
    assert.equal(guessApp(5223, 'TCP', ''), 'APNs'));

  it('5228/TCP → FCM', () =>
    assert.equal(guessApp(5228, 'TCP', ''), 'FCM'));

  it('7000/TCP → AirPlay', () =>
    assert.equal(guessApp(7000, 'TCP', ''), 'AirPlay'));

  it('8883/TCP → MQTT/TLS', () =>
    assert.equal(guessApp(8883, 'TCP', ''), 'MQTT/TLS'));

  it('17472/TCP → SESAME', () =>
    assert.equal(guessApp(17472, 'TCP', ''), 'SESAME'));

  it('55443/TCP → Alexa', () =>
    assert.equal(guessApp(55443, 'TCP', ''), 'Alexa'));

  it('123/TCP → empty (NTP is UDP-only)', () =>
    assert.equal(guessApp(123, 'TCP', ''), ''));

  it('5353/TCP → empty (mDNS is UDP-only)', () =>
    assert.equal(guessApp(5353, 'TCP', ''), ''));

  it('unknown port → empty', () =>
    assert.equal(guessApp(12345, 'TCP', ''), ''));
});

// ─── TCP hostname matching (port 443 / 80) ─────────────────────────────────────

describe('guessApp — TCP hostname matching', () => {
  it('443/TCP gs.apple.com → Apple', () =>
    assert.equal(guessApp(443, 'TCP', 'gs.apple.com'), 'Apple'));

  it('443/TCP icloud.com → iCloud', () =>
    assert.equal(guessApp(443, 'TCP', 'icloud.com'), 'iCloud'));

  it('443/TCP p68-content.icloud.com → iCloud (subdomain)', () =>
    assert.equal(guessApp(443, 'TCP', 'p68-content.icloud.com'), 'iCloud'));

  it('443/TCP www.youtube.com → YouTube', () =>
    assert.equal(guessApp(443, 'TCP', 'www.youtube.com'), 'YouTube'));

  it('443/TCP googleapis.com → Google API', () =>
    assert.equal(guessApp(443, 'TCP', 'googleapis.com'), 'Google API'));

  it('443/TCP s3.amazonaws.com → AWS', () =>
    assert.equal(guessApp(443, 'TCP', 's3.amazonaws.com'), 'AWS'));

  it('443/TCP prod.api.tuyacn.com → Tuya Smart', () =>
    assert.equal(guessApp(443, 'TCP', 'prod.api.tuyacn.com'), 'Tuya Smart'));

  it('443/TCP *.gaijin.net → Gaijin / DCS', () =>
    assert.equal(guessApp(443, 'TCP', 'trade.gaijin.net'), 'Gaijin / DCS'));

  it('443/TCP yandex.net → Yandex', () =>
    assert.equal(guessApp(443, 'TCP', 'yandex.net'), 'Yandex'));

  it('443/TCP unknown host → HTTPS (fallback)', () =>
    assert.equal(guessApp(443, 'TCP', 'unknown.example.com'), 'HTTPS'));

  it('80/TCP www.google.com → Google', () =>
    assert.equal(guessApp(80, 'TCP', 'www.google.com'), 'Google'));

  it('hostname matching skipped for UDP 443', () =>
    assert.equal(guessApp(443, 'UDP', 'www.youtube.com'), 'QUIC'));
});

// ─── Protocol case insensitivity ──────────────────────────────────────────────

describe('guessApp — protocol case insensitivity', () => {
  it('accepts lowercase "udp"', () =>
    assert.equal(guessApp(443, 'udp', ''), 'QUIC'));

  it('accepts mixed case "Udp"', () =>
    assert.equal(guessApp(443, 'Udp', ''), 'QUIC'));

  it('accepts lowercase "tcp"', () =>
    assert.equal(guessApp(443, 'tcp', ''), 'HTTPS'));
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('guessApp — edge cases', () => {
  it('null proto falls back to port map', () =>
    assert.equal(guessApp(443, null, ''), 'HTTPS'));

  it('undefined proto falls back to port map', () =>
    assert.equal(guessApp(443, undefined, ''), 'HTTPS'));

  it('port as string is coerced', () =>
    assert.equal(guessApp('5223', 'TCP', ''), 'APNs'));

  it('port 0 → empty', () =>
    assert.equal(guessApp(0, 'TCP', ''), ''));
});
