'use strict';

let _lang = 'ja';

const STRINGS = {
  // ── Device identification guesses ────────────────────────────────────────
  'device.airplay':        { ja: 'Apple AirPlay 機器',                              en: 'Apple AirPlay Device' },
  'device.iphone':         { ja: 'Apple iPhone/iPad',                              en: 'Apple iPhone/iPad' },
  'device.mac':            { ja: 'Apple Mac',                                      en: 'Apple Mac' },
  'device.homekit':        { ja: 'HomeKit アクセサリ',                              en: 'HomeKit Accessory' },
  'device.roku':           { ja: '★ Roku ストリーミング機器',                        en: '★ Roku Streaming Device' },
  'device.syncthing':      { ja: 'Syncthing 同期サーバ',                            en: 'Syncthing Sync Server' },
  'device.sonos':          { ja: '★ Sonos スピーカー',                             en: '★ Sonos Speaker' },
  'device.bose':           { ja: '★ Bose SoundTouch スピーカー',                   en: '★ Bose SoundTouch Speaker' },
  'device.denon':          { ja: '★ Denon/Marantz HEOS (オーディオ)',               en: '★ Denon/Marantz HEOS (Audio)' },
  'device.yamahacast':     { ja: '★ Yamaha MusicCast (オーディオ)',                 en: '★ Yamaha MusicCast (Audio)' },
  'device.nvidia':         { ja: '★ NVIDIA Shield / GeForce 系',                   en: '★ NVIDIA Shield / GeForce' },
  'device.tasmota':        { ja: '★ Tasmota IoT デバイス',                         en: '★ Tasmota IoT Device' },
  'device.esphome':        { ja: '★ ESPHome IoT デバイス',                         en: '★ ESPHome IoT Device' },
  'device.shelly':         { ja: '★ Shelly IoT スイッチ',                          en: '★ Shelly IoT Switch' },
  'device.matter':         { ja: '★ Matter 対応スマートデバイス',                    en: '★ Matter Smart Device' },
  'device.dial':           { ja: 'DIAL 対応 Smart TV (LG/Samsung/Sony 等)',         en: 'DIAL Smart TV (LG/Samsung/Sony)' },
  'device.chromecast':     { ja: 'Chromecast / Google Cast 対応機器',               en: 'Chromecast / Google Cast Device' },
  'device.castport':       { ja: 'Cast プロトコル対応機器（Chromecast互換ポート）',    en: 'Cast-compatible Device (Chromecast Port)' },
  'device.printer':        { ja: 'プリンタ',                                       en: 'Printer' },
  'device.spotify':        { ja: 'Spotify Connect 対応機器',                       en: 'Spotify Connect Device' },
  'device.smb':            { ja: 'SMB/NAS 対応',                                  en: 'SMB/NAS Compatible' },
  'device.matter-esphome': { ja: 'Matter/ESPHome IoT',                            en: 'Matter/ESPHome IoT' },
  'device.windows':        { ja: 'Windows/SMB 対応機器',                           en: 'Windows/SMB Device' },
  'device.ssh':            { ja: 'SSH 可能なホスト (Linux/サーバ)',                  en: 'SSH-capable Host (Linux/Server)' },
  'device.amazon-http':    { ja: '★ HTTP応答に Amazon 関連文字列 → Amazon機器',      en: '★ Amazon strings in HTTP response → Amazon Device' },

  // ── Investigation section headers ────────────────────────────────────────
  'investigation.inference': { ja: '🎯 推論: ',  en: '🎯 Inference: ' },
  'investigation.notes':     { ja: '   補足: ', en: '   Notes: ' },
  'investigation.no-info':   {
    ja: '(調査でホスト名・サービス・ポートいずれも検出できず。mDNS/UPnPは L2 マルチキャストのため、サーバーが対象LANと別セグメントの場合は届きません)',
    en: '(No hostname, service, or open port detected. mDNS/UPnP use L2 multicast; the server cannot discover them across network segments.)',
  },

  // ── Yamaha SSH poller ────────────────────────────────────────────────────
  'yamaha.reconnecting':   { ja: '再接続中…',                                       en: 'Reconnecting…' },
  'yamaha.no-config':      { ja: 'YamahaのIP、ユーザー名、パスワードを入力してください', en: 'Enter Yamaha IP, username, and password' },
  'yamaha.connecting':     { ja: '接続中…',                                         en: 'Connecting…' },
  'yamaha.shell-failed':   { ja: 'シェル要求失敗: ',                                 en: 'Shell request failed: ' },
  'yamaha.connected':      { ja: '接続済み',                                        en: 'Connected' },
  'yamaha.init-failed':    { ja: '初期化失敗: ',                                     en: 'Initialization failed: ' },
  'yamaha.ssh-failed':     { ja: 'SSH接続失敗: ',                                   en: 'SSH connection failed: ' },

  // ── ASUS router poller ───────────────────────────────────────────────────
  'asus.nonce-failed':     { ja: 'ノンス取得失敗 — ルーターIPを確認してください',           en: 'Failed to get nonce — check the router IP' },
  'asus.wrong-credentials':{ ja: 'ユーザー名またはパスワードが違います',                   en: 'Invalid username or password' },
  'asus.renew-failed':     { ja: 'ASUSの自動再認証に失敗しました。設定から再ログインしてください。', en: 'ASUS auto-renew failed. Please re-login from settings.' },
  'asus.session-expired':  { ja: 'セッションが切れました。再ログインしてください。',           en: 'Session expired. Please re-login.' },

  // ── Auth routes ──────────────────────────────────────────────────────────
  'auth.not-init':           { ja: '認証未初期化',                                   en: 'Auth not initialized' },
  'auth.enter-password':     { ja: 'パスワードを入力してください',                      en: 'Please enter a password' },
  'auth.wrong-password':     { ja: 'パスワードが違います',                             en: 'Wrong password' },
  'auth.session-failed':     { ja: 'セッション作成に失敗しました',                      en: 'Failed to create session' },
  'auth.password-too-short': { ja: '新しいパスワードは8文字以上で指定してください',         en: 'New password must be at least 8 characters' },
  'auth.current-wrong':      { ja: '現在のパスワードが違います',                        en: 'Current password is wrong' },
  'auth.token-invalid':      { ja: 'トークン不正',                                   en: 'Invalid token' },
  'auth.ip-not-allowed':     {
    ja: 'IPアドレスはプライベート範囲(10/8, 172.16/12, 192.168/16)のみ許可されます',
    en: 'Only private IP ranges (10/8, 172.16/12, 192.168/16) are allowed',
  },
  'auth.request-failed':     { ja: 'リクエスト失敗',                                 en: 'Request failed' },
  'auth.password-too-long':  { ja: 'パスワードが長すぎます',                           en: 'Password is too long' },
  'auth.yamaha-no-config':   { ja: 'YamahaのIP、ユーザー名、パスワードを入力してください', en: 'Enter Yamaha IP, username, and password' },
  'auth.yamaha-detect-failed': {
    ja: 'Yamaha自動検出に失敗しました（IP・ユーザー名・パスワード・SSH設定を確認してください）',
    en: 'Yamaha auto-detect failed (check IP, username, password, and SSH settings)',
  },
  'auth.asus-no-config':     { ja: 'ASUSルーターのユーザー名とパスワードを入力してください', en: 'Enter ASUS router username and password' },
  'auth.asus-auth-failed':   {
    ja: 'ASUS認証失敗（IP・ユーザー名・パスワードを確認してください）',
    en: 'ASUS authentication failed (check IP, username, and password)',
  },
  'auth.yamaha-update-failed': { ja: 'Yamaha設定の更新に失敗しました',                en: 'Failed to update Yamaha settings' },
  'auth.rate-limited':       {
    ja: '試行回数が多すぎます。{n}秒後に再試行してください',
    en: 'Too many attempts. Retry in {n} seconds.',
  },

  'auth.not-init-verify':    { ja: '未初期化',                                   en: 'Not initialized' },
  'auth.no-target':          { ja: '設定対象を指定してください',                    en: 'Please specify a configuration target' },
  'auth.asus-ip-private':    { ja: 'ASUSのIPがプライベート範囲外です',              en: 'ASUS IP is outside the private range' },
  'auth.yamaha-ip-private':  { ja: 'YamahaのIPがプライベート範囲外です',            en: 'Yamaha IP is outside the private range' },
  'auth.username-too-long':  { ja: 'ユーザー名が長すぎます',                       en: 'Username is too long' },
  'auth.yamaha-nat-invalid': { ja: 'yamahaNat は1〜6桁の数値で指定してください',    en: 'yamahaNat must be a 1–6 digit number' },

  // ── Config routes ────────────────────────────────────────────────────────
  'config.invalid-country':  { ja: '無効な国コードです',                              en: 'Invalid country code' },

  // ── Device routes ────────────────────────────────────────────────────────
  'device.merge-missing-id':  { ja: 'keepId と dropId が必要です',                   en: 'keepId and dropId are required' },
  'device.merge-same-id':     { ja: 'keepId と dropId は異なる必要があります',         en: 'keepId and dropId must be different' },
  'device.not-found':         { ja: 'デバイスが見つかりません',                        en: 'Device not found' },
  'device.id-required':       { ja: 'id が必要です',                                 en: 'id is required' },
  'device.device-id-required':{ ja: 'deviceId が必要です',                           en: 'deviceId is required' },
  'device.already-archived':  { ja: 'デバイスが見つからないか既にアーカイブ済みです',     en: 'Device not found or already archived' },

  // ── Notes routes ─────────────────────────────────────────────────────────
  'notes.invalid-ip':         { ja: '有効なプライベートIPを指定してください',            en: 'Please provide a valid private IP address' },
};

function t(key, vars) {
  const tmpl = (STRINGS[key]?.[_lang]) ?? (STRINGS[key]?.ja) ?? key;
  if (!vars) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

function setLanguage(lang) {
  if (lang === 'ja' || lang === 'en') _lang = lang;
}

function getLang() { return _lang; }

module.exports = { t, setLanguage, getLang };
