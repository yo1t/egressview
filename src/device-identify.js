// OUI vendor lookup, mDNS, SSDP, NetBIOS, Apple model dictionary, investigation
'use strict';
const logger = require('./logger');

const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { isAllowedRouterIp } = require('./utils');
const { t, getLang } = require('./i18n-server');

// bonjour-service is a heavyweight optional dep
let Bonjour = null;
try { Bonjour = require('bonjour-service').default || require('bonjour-service').Bonjour; }
catch { logger.warn('[bonjour] bonjour-service not installed (Phase2 mDNS skipped)'); }

// ─── OUI vendor database ──────────────────────────────────────────────────────
const OUI_URL   = 'https://www.wireshark.org/download/automated/data/manuf';
const OUI_CACHE = path.join(__dirname, '..', '.oui_cache.txt');
const OUI_TTL   = 7 * 24 * 60 * 60 * 1000; // 1 week

let ouiDb = new Map(); // "CC28AA" → "ASUSTeK COMPUTER INC."

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

async function loadOuiDb() {
  let text = null;
  try {
    const stat = fs.statSync(OUI_CACHE);
    if (Date.now() - stat.mtimeMs < OUI_TTL) {
      text = fs.readFileSync(OUI_CACHE, 'utf8');
      logger.info(`[oui] Cache loaded (${ouiDb.size || '…'} entries)`);
    }
  } catch {}

  if (!text) {
    logger.info('[oui] Downloading Wireshark OUI database…');
    try {
      const res = await axios.get(OUI_URL, { timeout: 30000, responseType: 'text' });
      text = res.data;
      fs.writeFileSync(OUI_CACHE, text);
    } catch (err) {
      logger.error('[oui] Download failed:', err.message);
      return;
    }
  }

  ouiDb = parseOuiManuf(text);
  logger.info(`[oui] ${ouiDb.size.toLocaleString()} OUI entries ready`);
}

function lookupVendor(mac) {
  const oui = mac.replace(/[:\-\.]/g, '').slice(0, 6).toUpperCase();
  return ouiDb.get(oui) || '';
}

function getOuiVendor(mac) {
  if (!mac || !ouiDb) return null;
  const prefix = mac.replace(/:/g, '').substring(0, 6).toUpperCase();
  return ouiDb.get(prefix) || null;
}

// ─── Data files (separated for easy maintenance) ─────────────────────────────
const APPLE_MODELS = require('./data/apple-models.json');

function lookupAppleModel(id) {
  if (!id) return null;
  return APPLE_MODELS[id] || null;
}

// ─── Vendor category inference (data-driven) ─────────────────────────────
const VENDOR_CATEGORIES = require('./data/vendor-categories.json');

function inferVendorCategory(vendor) {
  if (!vendor) return null;
  const v = vendor.toLowerCase();
  for (const entry of VENDOR_CATEGORIES) {
    if (v.includes(entry.match)) return { brand: entry.brand, category: entry.category, categoryEn: entry.categoryEn };
  }
  return null;
}

// ─── Node metadata cache ──────────────────────────────────────────────────────
const nodeMetaCache = new Map(); // ip -> { vendor, dnsName, mdnsName, lastFetched }
const NODE_META_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getNodeMeta(ip, mac) {
  let meta = nodeMetaCache.get(ip);
  const now = Date.now();
  const immediateVendor = getOuiVendor(mac);
  if (!meta) {
    meta = { vendor: immediateVendor, dnsName: null, mdnsName: null, lastFetched: 0 };
    nodeMetaCache.set(ip, meta);
    refreshNodeMeta(ip, mac);
  } else if (immediateVendor && !meta.vendor) {
    meta.vendor = immediateVendor;
  } else if (now - meta.lastFetched > NODE_META_TTL_MS) {
    refreshNodeMeta(ip, mac);
  }
  return meta;
}

async function refreshNodeMeta(ip, mac) {
  if (!isAllowedRouterIp(ip)) return;
  const meta = nodeMetaCache.get(ip) || { vendor: null, dnsName: null, mdnsName: null, lastFetched: 0 };
  if (mac) meta.vendor = getOuiVendor(mac) || meta.vendor;
  try {
    const arr = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('to')), 1500))
    ]);
    meta.dnsName = (arr && arr[0]) || null;
  } catch { /* keep previous */ }
  try {
    if (Bonjour) {
      const services = await probeBonjourForIp(ip, 2000);
      const named = services.find(s => s.host);
      if (named) meta.mdnsName = named.host;
    }
  } catch { /* keep previous */ }
  meta.lastFetched = Date.now();
  nodeMetaCache.set(ip, meta);
}

// ─── Probes ───────────────────────────────────────────────────────────────────
function probeTcp(ip, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
    sock.connect(port, ip);
  });
}

async function probeHttpBanner(ip, port, https_ = false) {
  try {
    const url = `${https_ ? 'https' : 'http'}://${ip}${port === (https_ ? 443 : 80) ? '' : ':' + port}/`;
    const r = await axios.get(url, {
      timeout: 2500, maxRedirects: 0, validateStatus: () => true,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }), // nosemgrep: bypass-tls-verification — LAN デバイス調査用。自己署名証明書が多いLAN機器専用。呼び出し元で isAllowedRouterIp() によりプライベートIPのみに制限
    });
    const server = r.headers['server'] || '';
    const realm  = (r.headers['www-authenticate'] || '').match(/realm="([^"]+)"/i)?.[1] || '';
    const body   = typeof r.data === 'string' ? r.data : '';
    const title  = (body.match(/<title>([^<]+)<\/title>/i)?.[1] || '').trim().substring(0, 80);
    return { port, server, title, realm };
  } catch { return null; }
}

function probeSsdp(targetIp, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 1\r\n' +
      'ST: ssdp:all\r\n\r\n'
    );
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== targetIp) return;
      const s = data.toString();
      const server = s.match(/SERVER:\s*([^\r\n]+)/i)?.[1]?.trim();
      const usn    = s.match(/USN:\s*([^\r\n]+)/i)?.[1]?.trim();
      const st     = s.match(/ST:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (server || usn || st) found.push({ server, usn, st });
    });
    sock.bind(() => {
      try { sock.send(msg, 1900, '239.255.255.250'); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, timeoutMs);
  });
}

function probeMdns(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const parts = ip.split('.').reverse();
    const name  = `${parts.join('.')}.in-addr.arpa`;
    const id = crypto.randomBytes(2);
    const flags = Buffer.from([0x00, 0x00]);
    const counts = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const qname = Buffer.concat(name.split('.').map(p => {
      const b = Buffer.from(p, 'utf8');
      return Buffer.concat([Buffer.from([b.length]), b]);
    }).concat([Buffer.from([0])]));
    const qtail = Buffer.from([0x00, 0x0c, 0x00, 0x01]);
    const packet = Buffer.concat([id, flags, counts, qname, qtail]);

    const sock = dgram.createSocket('udp4');
    let host = null;
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== ip && rinfo.address !== '224.0.0.251') return;
      const m = data.toString('binary').match(/[\x01-\x40]([A-Za-z0-9\-_]{2,63})\x05local/);
      if (m) host = m[1] + '.local';
    });
    sock.bind(() => {
      try { sock.setMulticastTTL(255); sock.send(packet, 5353, ip); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(host); }, timeoutMs);
  });
}

// ─── Bonjour (data-driven) ─────────────────────────────────────────────────
const BONJOUR_TYPES = require('./data/bonjour-types.json');

let bonjourInstance = null;
function getBonjour() {
  if (!Bonjour) return null;
  if (!bonjourInstance) bonjourInstance = new Bonjour();
  return bonjourInstance;
}

function probeBonjourForIp(ip, timeoutMs = 3000) {
  return new Promise(resolve => {
    const bonjour = getBonjour();
    if (!bonjour) return resolve([]);
    const matches = [];
    const browsers = [];
    try {
      for (const type of BONJOUR_TYPES) {
        const browser = bonjour.find({ type, protocol: 'tcp' }, service => {
          const addrs = service.addresses || [];
          if (addrs.includes(ip)) {
            const txt = service.txt || {};
            matches.push({ type, name: service.name, host: service.host, port: service.port, txt });
          }
        });
        browsers.push(browser);
      }
    } catch (e) {
      logger.error('[bonjour] error:', e.message);
    }
    setTimeout(() => {
      browsers.forEach(b => { try { b.stop(); } catch {} });
      const seen = new Set();
      const uniq = matches.filter(m => {
        const k = m.type + '|' + m.name;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      resolve(uniq);
    }, timeoutMs);
  });
}

// ─── NetBIOS ──────────────────────────────────────────────────────────────────
function encodeNetbiosName(name) {
  let n = name.toUpperCase();
  while (n.length < 16) n += ' ';
  n = n.substring(0, 15) + '\x00';
  let out = '';
  for (let i = 0; i < n.length; i++) {
    const b = n.charCodeAt(i);
    out += String.fromCharCode(((b >> 4) & 0x0F) + 0x41);
    out += String.fromCharCode((b & 0x0F) + 0x41);
  }
  return out;
}

function probeNetbios(ip, timeoutMs = 1500) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const txid = crypto.randomBytes(2);
    const flags = Buffer.from([0x00, 0x00]);
    const counts = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const encName = encodeNetbiosName('*');
    const qname = Buffer.concat([
      Buffer.from([32]),
      Buffer.from(encName, 'ascii'),
      Buffer.from([0]),
    ]);
    const qtail = Buffer.from([0x00, 0x21, 0x00, 0x01]); // NBSTAT / IN
    const packet = Buffer.concat([txid, flags, counts, qname, qtail]);
    let result = null;
    sock.on('message', (data, rinfo) => {
      if (rinfo.address !== ip) return;
      try {
        const offset = 12 + 34 + 12;
        if (data.length < offset + 1) return;
        const numNames = data[offset];
        let workstation = null;
        let domain = null;
        for (let i = 0; i < numNames; i++) {
          const start = offset + 1 + i * 18;
          if (start + 18 > data.length) break;
          const rawName = data.slice(start, start + 15).toString('ascii').replace(/\s+$/g, '').trim();
          const suffix = data[start + 15];
          const flagsHi = data[start + 16];
          const groupFlag = (flagsHi & 0x80) !== 0;
          if (!rawName) continue;
          if (suffix === 0x00 && !groupFlag) workstation = rawName;
          if (suffix === 0x00 && groupFlag) domain = rawName;
        }
        result = { workstation, domain };
      } catch {}
    });
    sock.bind(() => {
      try { sock.send(packet, 137, ip); } catch {}
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(result); }, timeoutMs);
  });
}

// ─── Investigation ────────────────────────────────────────────────────────────
async function investigateIp(ip, { ouiDb: ouiDbRef, yamahaExec, yamahaEnabled, yamahaReady } = {}) {
  if (!isAllowedRouterIp(ip)) return { error: 'IP範囲外' };
  const db = ouiDbRef || ouiDb;

  // Look up MAC from ARP table via Yamaha (if available)
  async function probeYamahaArp(targetIp) {
    if (!yamahaEnabled || !yamahaReady || !yamahaExec) return null;
    try {
      const raw = await yamahaExec(`show arp`);
      const re = new RegExp(`(?:^|\\s)${targetIp.replace(/\./g, '\\.')}\\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})`);
      const m = raw.match(re);
      if (m) return m[1].toLowerCase();
    } catch (e) {
      logger.error('[arp] error:', e.message);
    }
    return null;
  }

  const commonPorts = [22, 53, 80, 139, 443, 445, 548, 631, 1883, 5000, 7000, 8009, 8080, 8443, 8883, 9100, 32400, 49152];
  const [portResults, http80, http443, http8080, ssdp, host, hostByDns, bonjourServices, netbios, arpMac] = await Promise.all([
    Promise.all(commonPorts.map(async p => ({ p, open: await probeTcp(ip, p) }))),
    probeHttpBanner(ip, 80),
    probeHttpBanner(ip, 443, true),
    probeHttpBanner(ip, 8080),
    probeSsdp(ip),
    probeMdns(ip),
    Promise.race([
      dns.reverse(ip).then(arr => arr[0]),
      new Promise(resolve => setTimeout(() => resolve(null), 1500)),
    ]).catch(() => null),
    probeBonjourForIp(ip, 3000),
    probeNetbios(ip),
    probeYamahaArp(ip),
  ]);
  const openPorts = portResults.filter(r => r.open).map(r => r.p);
  const httpInfo = [http80, http443, http8080].filter(Boolean);

  const story = [];
  story.push(`📍 ${ip}`);

  let mac = arpMac;
  let vendor = null;
  let vendorInfo = null;
  if (mac) {
    vendor = db?.get(mac.replace(/:/g, '').substring(0, 6).toUpperCase()) || null;
    vendorInfo = inferVendorCategory(vendor);
    const firstByte = parseInt(mac.split(':')[0], 16);
    const isLocallyAdmin = (firstByte & 0x02) !== 0;
    let macLine = `    ${mac}`;
    if (vendor) macLine += ` — ${vendor}`;
    if (isLocallyAdmin) macLine += ' (locally administered/プライバシーMAC)';
    story.push(`  ↓ ARP (Yamaha)\n${macLine}`);
  }

  if (hostByDns) story.push(`  ↓ DNS reverse\n    ${hostByDns}`);

  let mdnsHost = host;
  if (!mdnsHost) {
    const named = bonjourServices?.find(s => s.host);
    if (named) mdnsHost = named.host;
  }
  if (mdnsHost) story.push(`  ↓ mDNS hostname\n    ${mdnsHost}.local`);

  if (netbios?.workstation) {
    story.push(`  ↓ NetBIOS NodeStatus\n    ${netbios.workstation}${netbios.domain ? ` (workgroup: ${netbios.domain})` : ''}`);
  }

  const bonjourTypes = new Set((bonjourServices || []).map(s => s.type));
  if (bonjourTypes.size) {
    story.push(`  ↓ Bonjour services\n    ${[...bonjourTypes].join(', ')}`);
  }

  let appleModelId = null;
  let modelSource = null;
  for (const s of bonjourServices || []) {
    const tx = s.txt || {};
    const m = tx.model || tx.am || tx.md || tx['model'];
    if (m && /^[A-Za-z]+\d+,\d+/.test(m)) {
      appleModelId = m;
      modelSource = s.type;
      break;
    }
  }
  if (appleModelId) {
    story.push(`  ↓ ${modelSource} TXT record\n    model=${appleModelId}`);
    const productName = lookupAppleModel(appleModelId);
    if (productName) story.push(`  ↓ Apple model identifier\n    ${productName}`);
  }

  if (openPorts.length) story.push(`  ↓ open TCP ports\n    ${openPorts.join(', ')}`);

  for (const h of httpInfo) {
    const seg = [];
    if (h.title)  seg.push(`title="${h.title}"`);
    if (h.server) seg.push(`Server: ${h.server}`);
    if (h.realm)  seg.push(`Realm: ${h.realm}`);
    if (seg.length) story.push(`  ↓ HTTP/${h.port}\n    ${seg.join(' / ')}`);
  }

  for (const s of (ssdp || [])) {
    if (s.server) story.push(`  ↓ SSDP\n    ${s.server}`);
  }

  // === Inference logic ===
  const guesses = [];
  const brand = vendorInfo?.brand || null;
  const httpText = httpInfo.map(h => `${h.title || ''} ${h.server || ''} ${h.realm || ''}`).join(' ').toLowerCase();
  const httpMentionsAmazon  = /amazon|echo|fire ?tv|kindle|alexa/.test(httpText);
  const httpMentionsGoogle  = /google|nest|chromecast/.test(httpText);

  if (appleModelId) {
    const name = lookupAppleModel(appleModelId);
    guesses.push(name ? `★ ${name}` : `★ Apple device (${appleModelId})`);
  }
  if (vendorInfo && !appleModelId) {
    const catLabel = getLang() === 'en' ? (vendorInfo.categoryEn || vendorInfo.category) : vendorInfo.category;
    guesses.push(`★ ${catLabel}`);
  }
  if (!appleModelId && !brand) {
    if (bonjourTypes.has('airplay') || bonjourTypes.has('raop'))             guesses.push(t('device.airplay'));
    if (bonjourTypes.has('companion-link') || bonjourTypes.has('apple-mobdev2')) guesses.push(t('device.iphone'));
    if (bonjourTypes.has('device-info') && !bonjourTypes.has('companion-link')) guesses.push(t('device.mac'));
  }
  if (bonjourTypes.has('homekit') || bonjourTypes.has('hap'))              guesses.push(t('device.homekit'));

  const types = [...bonjourTypes];
  const hasAmznService = types.some(svc => svc.startsWith('amzn-'));
  const hasLgService   = types.some(svc => svc.startsWith('lg-') || svc === 'lgsmart' || svc === 'lg2nd-screen');
  const hasSamsungSvc  = types.some(svc => svc.startsWith('samsung') || svc === 'sectv');
  const hasSonyPsn     = types.includes('psnpipe') || types.includes('acn-link');
  const hasSonySvc     = types.includes('aquos');
  const hasSynology    = types.some(svc => svc.startsWith('synology'));

  if (hasAmznService) guesses.push('★ Amazon Alexa/Echo (Bonjour amzn-*)');
  if (hasLgService)   guesses.push('★ LG Smart TV (webOS)');
  if (hasSamsungSvc)  guesses.push('★ Samsung Smart TV');
  if (hasSonyPsn)     guesses.push('★ Sony PlayStation');
  if (hasSonySvc)     guesses.push('★ Sharp/Sony AQUOS');
  if (bonjourTypes.has('rsp'))             guesses.push(t('device.roku'));
  if (bonjourTypes.has('plexmediasvr'))    guesses.push('★ Plex Media Server');
  if (hasSynology)                          guesses.push('★ Synology NAS');
  if (bonjourTypes.has('syncthing'))       guesses.push(t('device.syncthing'));
  if (bonjourTypes.has('sonos'))           guesses.push(t('device.sonos'));
  if (bonjourTypes.has('soundtouch'))      guesses.push(t('device.bose'));
  if (bonjourTypes.has('heos-audio'))      guesses.push(t('device.denon'));
  if (bonjourTypes.has('musiccast') || bonjourTypes.has('yxc')) guesses.push(t('device.yamahacast'));
  if (bonjourTypes.has('shield') || bonjourTypes.has('gamestream') || bonjourTypes.has('nvstream'))
    guesses.push(t('device.nvidia'));
  if (bonjourTypes.has('wemo'))            guesses.push('★ Belkin WeMo IoT');
  if (bonjourTypes.has('tasmota'))         guesses.push(t('device.tasmota'));
  if (bonjourTypes.has('esphome') || bonjourTypes.has('esphomelib'))
    guesses.push(t('device.esphome'));
  if (bonjourTypes.has('shelly'))          guesses.push(t('device.shelly'));
  if (bonjourTypes.has('home-assistant'))  guesses.push('★ Home Assistant');
  if (bonjourTypes.has('matter'))          guesses.push(t('device.matter'));
  if (bonjourTypes.has('dial') && !hasLgService && !hasSamsungSvc && !bonjourTypes.has('googlecast'))
    guesses.push(t('device.dial'));

  if (bonjourTypes.has('googlecast')) {
    guesses.push(t('device.chromecast'));
  } else if (openPorts.includes(8009) && (brand === 'Google' || httpMentionsGoogle)) {
    guesses.push(t('device.chromecast'));
  } else if (openPorts.includes(8009) && brand !== 'Amazon' && !hasAmznService && !brand) {
    guesses.push(t('device.castport'));
  }

  if (bonjourTypes.has('ipp') || bonjourTypes.has('ipps') || bonjourTypes.has('printer') || openPorts.includes(631) || openPorts.includes(9100))
    guesses.push(t('device.printer'));
  if (bonjourTypes.has('spotify-connect')) guesses.push(t('device.spotify'));
  if (bonjourTypes.has('hue'))             guesses.push('Philips Hue Bridge');
  if (bonjourTypes.has('matter') || bonjourTypes.has('esphomelib')) guesses.push(t('device.matter-esphome'));
  if (bonjourTypes.has('smb') || openPorts.includes(445))   guesses.push(t('device.smb'));
  if (openPorts.includes(32400))                            guesses.push('Plex Media Server');
  if (openPorts.includes(1883) || openPorts.includes(8883)) guesses.push('MQTT/IoT');
  if (netbios?.workstation && !brand?.includes('Apple') && !guesses.some(g => g.includes('Apple'))) {
    guesses.push(t('device.windows'));
  }
  if (!guesses.length && openPorts.includes(22))            guesses.push(t('device.ssh'));

  if (httpMentionsAmazon && !guesses.some(g => g.includes('Amazon'))) {
    guesses.unshift(t('device.amazon-http'));
  }

  const uniqGuesses = [...new Set(guesses)];
  if (uniqGuesses.length) {
    story.push('');
    const strong = uniqGuesses.filter(g => g.startsWith('★ ')).map(g => g.replace(/^★\s+/, ''));
    const weak   = uniqGuesses.filter(g => !g.startsWith('★ '));
    if (strong.length) story.push(`${t('investigation.inference')}${strong.join(' / ')}`);
    if (weak.length)   story.push(`${t('investigation.notes')}${weak.join(' / ')}`);
  }

  if (story.length === 1) {
    story.push(t('investigation.no-info'));
  }

  return {
    draft: story.join('\n'),
    raw: { mac: arpMac, openPorts, httpInfo, ssdp, host: mdnsHost, hostByDns, bonjourServices, netbios, appleModelId },
  };
}

module.exports = {
  parseOuiManuf,
  loadOuiDb,
  lookupVendor,
  getOuiVendor,
  lookupAppleModel,
  inferVendorCategory,
  getNodeMeta,
  refreshNodeMeta,
  investigateIp,
  probeTcp,
  probeHttpBanner,
  probeSsdp,
  probeMdns,
  probeBonjourForIp,
  probeNetbios,
  getOuiDb: () => ouiDb,
};
