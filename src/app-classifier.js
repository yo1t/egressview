'use strict';

const PORT_MAP = {
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

const UDP_MAP = {
  53: 'DNS',
  67: 'DHCP', 68: 'DHCP', 69: 'TFTP',
  80: 'QUIC',
  123: 'NTP',
  137: 'NetBIOS', 138: 'NetBIOS',
  161: 'SNMP', 162: 'SNMP Trap',
  443: 'QUIC',
  500: 'IPSec IKE',
  3478: 'STUN',
  3544: 'Teredo',
  4500: 'IPSec/NAT',
  5353: 'mDNS',
  51820: 'WireGuard',
};

const HOST_MAP = [
  ['icloud.com', 'iCloud'],
  ['apple.com', 'Apple'],
  ['apple-dns.net', 'Apple DNS'],
  ['mzstatic.com', 'App Store'],
  ['googleapis.com', 'Google API'],
  ['googlevideo.com', 'YouTube'],
  ['youtube.com', 'YouTube'],
  ['google.com', 'Google'],
  ['gstatic.com', 'Google'],
  ['2mdn.net', 'Google Ads'],
  ['doubleclick.net', 'Google Ads'],
  ['amazonaws.com', 'AWS'],
  ['cloudfront.net', 'CloudFront'],
  ['amazon.com', 'Amazon'],
  ['microsoft.com', 'Microsoft'],
  ['office.com', 'Microsoft 365'],
  ['office365.com', 'Microsoft 365'],
  ['live.com', 'Microsoft'],
  ['azure.com', 'Azure'],
  ['msftncsi.com', 'Microsoft'],
  ['netflix.com', 'Netflix'],
  ['nflxvideo.net', 'Netflix'],
  ['nflximg.net', 'Netflix'],
  ['facebook.com', 'Meta'],
  ['instagram.com', 'Meta'],
  ['whatsapp.net', 'WhatsApp'],
  ['fbcdn.net', 'Meta CDN'],
  ['twitter.com', 'X / Twitter'],
  ['x.com', 'X / Twitter'],
  ['twimg.com', 'X / Twitter'],
  ['slack.com', 'Slack'],
  ['zoom.us', 'Zoom'],
  ['dropbox.com', 'Dropbox'],
  ['spotify.com', 'Spotify'],
  ['scdn.co', 'Spotify CDN'],
  ['cloudflare.com', 'Cloudflare'],
  ['cloudflare-dns.com', 'Cloudflare DNS'],
  ['yandex.net', 'Yandex'],
  ['yandex.ru', 'Yandex'],
  ['gaijin.net', 'Gaijin / DCS'],
  ['gaijinent.com', 'Gaijin / DCS'],
  ['akamai.net', 'Akamai'],
  ['akamaitechnologies.com', 'Akamai'],
  ['fastly.net', 'Fastly'],
  ['tuyaus.com', 'Tuya Smart'],
  ['tuyacn.com', 'Tuya Smart'],
  ['tuyaeu.com', 'Tuya Smart'],
  ['tuyain.com', 'Tuya Smart'],
  ['dyson.com', 'Dyson'],
];

function guessApp(dport, proto, dstHost) {
  const port = Number(dport);
  const isUDP = proto && proto.toUpperCase() === 'UDP';
  if (isUDP && UDP_MAP[port]) return UDP_MAP[port];
  if (!isUDP && dstHost && [443, 80, 8443, 8080].includes(port)) {
    const host = String(dstHost).toLowerCase().replace(/:\d+$/, '');
    for (const [suffix, label] of HOST_MAP) {
      if (host === suffix || host.endsWith('.' + suffix)) return label;
    }
  }
  return PORT_MAP[port] || '';
}

function summarizeAppGroups(rows, unknownLabel = 'Unknown') {
  const counts = new Map();
  for (const row of rows || []) {
    const app = row.app || guessApp(row.dport, row.proto, row.dstHost || row.dst) || unknownLabel;
    const attribution = row.attribution || null;
    const key = `${attribution || ''}\u0000${app}`;
    const current = counts.get(key) || { app, count: 0, attribution };
    current.count += row.count || 0;
    counts.set(key, current);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

module.exports = { guessApp, summarizeAppGroups };
