'use strict';
// Sample connections for demo / CI mode (DEMO_MODE=true).
// Data is synthetic — private IPs + well-known public services.

const DEVICES = [
  { src: '192.168.1.10', srcMac: 'aa:bb:cc:11:22:33', srcVendor: 'Apple, Inc.', srcMdnsName: 'macbook.local' },
  { src: '192.168.1.11', srcMac: 'dd:ee:ff:44:55:66', srcVendor: 'Apple, Inc.', srcMdnsName: 'iphone.local' },
  { src: '192.168.1.20', srcMac: '00:11:22:aa:bb:cc', srcVendor: 'Dell Inc.',   srcDnsName:  'desktop.home' },
  { src: '192.168.1.30', srcMac: '66:77:88:99:aa:bb', srcVendor: 'Samsung Electronics' },
];

const DESTINATIONS = [
  { dst: '8.8.8.8',         dport: 53,  proto: 'UDP', dstHost: 'dns.google',          country: 'US', org: 'Google LLC' },
  { dst: '8.8.4.4',         dport: 53,  proto: 'UDP', dstHost: 'dns.google',          country: 'US', org: 'Google LLC' },
  { dst: '1.1.1.1',         dport: 53,  proto: 'UDP', dstHost: 'one.one.one.one',     country: 'US', org: 'Cloudflare, Inc.' },
  { dst: '142.250.185.78',  dport: 443, proto: 'TCP', dstHost: 'www.google.com',      country: 'US', org: 'Google LLC' },
  { dst: '142.250.196.46',  dport: 443, proto: 'TCP', dstHost: 'apis.google.com',     country: 'US', org: 'Google LLC' },
  { dst: '172.217.161.46',  dport: 80,  proto: 'TCP', dstHost: 'www.gstatic.com',     country: 'US', org: 'Google LLC' },
  { dst: '151.101.1.140',   dport: 443, proto: 'TCP', dstHost: 'github.com',          country: 'US', org: 'Fastly, Inc.' },
  { dst: '104.16.133.229',  dport: 443, proto: 'TCP', dstHost: 'www.cloudflare.com',  country: 'US', org: 'Cloudflare, Inc.' },
  { dst: '13.107.42.14',    dport: 443, proto: 'TCP', dstHost: 'login.microsoft.com', country: 'IE', org: 'Microsoft Corporation' },
  { dst: '40.126.28.12',    dport: 443, proto: 'TCP', dstHost: 'outlook.com',         country: 'IE', org: 'Microsoft Corporation' },
  { dst: '52.114.132.73',   dport: 443, proto: 'TCP', dstHost: 'teams.microsoft.com', country: 'IE', org: 'Microsoft Corporation' },
  { dst: '17.253.144.10',   dport: 443, proto: 'TCP', dstHost: 'apple.com',           country: 'US', org: 'Apple Inc.' },
  { dst: '17.57.145.132',   dport: 443, proto: 'TCP', dstHost: 'icloud.com',          country: 'US', org: 'Apple Inc.' },
  { dst: '205.251.242.103', dport: 443, proto: 'TCP', dstHost: 'amazonaws.com',       country: 'US', org: 'Amazon.com, Inc.' },
  { dst: '52.94.236.248',   dport: 443, proto: 'TCP', dstHost: 's3.amazonaws.com',    country: 'US', org: 'Amazon.com, Inc.' },
  { dst: '210.152.243.234', dport: 443, proto: 'TCP', dstHost: 'www.yahoo.co.jp',     country: 'JP', org: 'Yahoo Japan Corporation' },
  { dst: '210.130.161.2',   dport: 443, proto: 'TCP', dstHost: 'www.nikkei.com',      country: 'JP', org: 'Nikkei Inc.' },
  { dst: '182.22.25.124',   dport: 443, proto: 'TCP', dstHost: 'line.me',             country: 'JP', org: 'LINE Corporation' },
  { dst: '31.13.92.36',     dport: 443, proto: 'TCP', dstHost: 'www.facebook.com',    country: 'IE', org: 'Meta Platforms, Inc.' },
  { dst: '157.240.8.35',    dport: 443, proto: 'TCP', dstHost: 'instagram.com',       country: 'US', org: 'Meta Platforms, Inc.' },
];

// Deterministic pseudo-random (no crypto dependency needed for demo data)
function prng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function seedDemoConnections(history) {
  const now = Date.now();
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  const rand = prng(0xdeadbeef);
  let seeded = 0;

  for (const device of DEVICES) {
    for (const dest of DESTINATIONS) {
      // Spread timestamps across the last 14 days; each pair appears multiple times
      const repeats = Math.floor(rand() * 3) + 1;
      for (let i = 0; i < repeats; i++) {
        const offset    = rand() * TWO_WEEKS_MS;
        const firstSeen = Math.floor(now - TWO_WEEKS_MS + offset);
        const ttl       = Math.floor(rand() * 4 * 60 * 60 * 1000); // up to 4h TTL
        const lastSeen  = Math.min(firstSeen + ttl, now);
        try {
          history.seedConnections([{ ...device, ...dest, firstSeen, lastSeen }]);
          seeded++;
        } catch {}
      }
    }
  }
  return seeded;
}

module.exports = { seedDemoConnections };
