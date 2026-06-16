// ─── Utilities ────────────────────────────────────────────────────────────────

const _BASE = window.BASE_URL || '';

// HTML escape (XSS mitigation: ASUS/Yamaha/DNS/RDAP-derived strings are untrusted)
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmtBytes(bps) {
  if (!bps || isNaN(bps)) return '0 B/s';
  const u = ['B/s','KB/s','MB/s','GB/s'];
  let i = 0;
  while (bps >= 1024 && i < u.length - 1) { bps /= 1024; i++; }
  return `${bps.toFixed(bps < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toTimeString().slice(0, 5);
}
function nodeColor(type) {
  if (type === '0') return '#ef4444';   // Wired: red
  if (type === '1') return '#10b981';   // 2.4GHz: green
  if (type === '2') return '#8b5cf6';   // 5GHz: purple
  if (type === '3') return '#eab308';   // 6GHz: yellow
  return '#6b7280';
}
function nodeClass(type) {
  if (type === '0') return 'wired';
  if (type === '1') return 'wifi-2g';
  if (type === '2') return 'wifi-5g';
  if (type === '3') return 'wifi-6g';
  return 'wired';
}
function typeLabel(type) {
  if (type === '0') return t('type.wired');
  if (type === '1') return t('type.wifi24');
  if (type === '2') return t('type.wifi5');
  if (type === '3') return t('type.wifi6');
  return t('type.unknown');
}
function isWiredType(type) { return type === '0'; }

// ─── Application / service name inference ─────────────────────────────────────

// TCP/UDP 共通（プロトコル不問）
const _PORT_MAP = {
  20: 'FTP', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
  53: 'DNS', 80: 'HTTP', 110: 'POP3', 137: 'NetBIOS', 138: 'NetBIOS',
  139: 'SMB', 143: 'IMAP', 389: 'LDAP',
  443: 'HTTPS', 445: 'SMB', 465: 'SMTP/TLS',
  554: 'RTSP', 587: 'SMTP', 636: 'LDAP/TLS', 853: 'DNS/TLS',
  993: 'IMAP/TLS', 995: 'POP3/TLS',
  1080: 'SOCKS', 1194: 'OpenVPN', 1723: 'PPTP', 1883: 'MQTT',
  1935: 'RTMP', 2049: 'NFS', 3306: 'MySQL', 3389: 'RDP',
  3478: 'STUN', 5004: 'RTP', 5060: 'SIP', 5061: 'SIP/TLS',
  5222: 'XMPP', 5223: 'APNs', 5228: 'FCM',
  5432: 'PostgreSQL', 5900: 'VNC',
  6379: 'Redis', 6881: 'BitTorrent',
  7000: 'AirPlay', 8080: 'HTTP-alt', 8443: 'HTTPS-alt',
  8883: 'MQTT/TLS', 9001: 'Tor', 17472: 'SESAME',
  25565: 'Minecraft', 27015: 'Steam', 27017: 'MongoDB',
  55443: 'Alexa',
};

// UDP 専用（TCP と意味が異なる、または UDP のみ使われるポート）
const _UDP_MAP = {
  53:    'DNS',
  67:    'DHCP', 68: 'DHCP', 69: 'TFTP',
  80:    'QUIC',            // HTTP/3
  123:   'NTP',
  137:   'NetBIOS', 138: 'NetBIOS',
  161:   'SNMP', 162: 'SNMP Trap',
  443:   'QUIC',            // HTTP/3
  500:   'IPSec IKE',
  3478:  'STUN',
  3544:  'Teredo',
  4500:  'IPSec/NAT',
  5353:  'mDNS',
  51820: 'WireGuard',
};

// hostname suffix → service label (longest match wins via iteration order)
const _HOST_MAP = [
  ['icloud.com',         'iCloud'],
  ['apple.com',          'Apple'],
  ['apple-dns.net',      'Apple DNS'],
  ['mzstatic.com',       'App Store'],
  ['googleapis.com',     'Google API'],
  ['googlevideo.com',    'YouTube'],
  ['youtube.com',        'YouTube'],
  ['google.com',         'Google'],
  ['gstatic.com',        'Google'],
  ['2mdn.net',           'Google Ads'],
  ['doubleclick.net',    'Google Ads'],
  ['amazonaws.com',      'AWS'],
  ['cloudfront.net',     'CloudFront'],
  ['amazon.com',         'Amazon'],
  ['microsoft.com',      'Microsoft'],
  ['office.com',         'Microsoft 365'],
  ['office365.com',      'Microsoft 365'],
  ['live.com',           'Microsoft'],
  ['azure.com',          'Azure'],
  ['msftncsi.com',       'Microsoft'],
  ['netflix.com',        'Netflix'],
  ['nflxvideo.net',      'Netflix'],
  ['nflximg.net',        'Netflix'],
  ['facebook.com',       'Meta'],
  ['instagram.com',      'Meta'],
  ['whatsapp.net',       'WhatsApp'],
  ['fbcdn.net',          'Meta CDN'],
  ['twitter.com',        'X / Twitter'],
  ['x.com',              'X / Twitter'],
  ['twimg.com',          'X / Twitter'],
  ['slack.com',          'Slack'],
  ['zoom.us',            'Zoom'],
  ['dropbox.com',        'Dropbox'],
  ['spotify.com',        'Spotify'],
  ['scdn.co',            'Spotify CDN'],
  ['cloudflare.com',     'Cloudflare'],
  ['cloudflare-dns.com', 'Cloudflare DNS'],
  ['yandex.net',         'Yandex'],
  ['yandex.ru',          'Yandex'],
  ['gaijin.net',         'Gaijin / DCS'],
  ['gaijinent.com',      'Gaijin / DCS'],
  ['akamai.net',         'Akamai'],
  ['akamaitechnologies.com', 'Akamai'],
  ['fastly.net',         'Fastly'],
  ['tuyaus.com',         'Tuya Smart'],
  ['tuyacn.com',         'Tuya Smart'],
  ['tuyaeu.com',         'Tuya Smart'],
  ['tuyain.com',         'Tuya Smart'],
  ['dyson.com',          'Dyson'],
];

function guessApp(dport, proto, dstHost) {
  const port = Number(dport);
  const isUDP = proto && proto.toUpperCase() === 'UDP';

  // UDP 専用マップを優先
  if (isUDP) {
    const udpLabel = _UDP_MAP[port];
    if (udpLabel) return udpLabel;
  }

  // TCP の web ポートはホスト名から判定（QUIC ではなく TCP の 443/80 のみ）
  if (!isUDP && dstHost && (port === 443 || port === 80 || port === 8443 || port === 8080)) {
    const host = dstHost.toLowerCase().replace(/:\d+$/, '');
    for (const [suffix, label] of _HOST_MAP) {
      if (host === suffix || host.endsWith('.' + suffix)) return label;
    }
  }

  return _PORT_MAP[port] || '';
}
