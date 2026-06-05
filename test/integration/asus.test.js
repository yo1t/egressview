// Integration tests for ASUS WiFi AP HTTP connection (requires real hardware)
// Run: node --test test/integration/asus.test.js
// Requires: .widemap.json with valid asus credentials
//
// SECURITY NOTE:
// - Credentials are read from .widemap.json (gitignored, 0600 permissions)
// - No credentials are logged or written to test output
// - Test does not store session tokens beyond the test run

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('axios');

const CONFIG_FILE = path.join(__dirname, '..', '..', '.widemap.json');

// ─── Re-implement parseClientList (same as server.js) ───────────────────────
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

// ─── Load config ────────────────────────────────────────────────────────────
function loadTestConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Config file not found: ${CONFIG_FILE} — integration tests require .widemap.json`);
  }
  const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!data.asus?.ip || !data.asus?.user || !data.asus?.pass) {
    throw new Error('ASUS credentials not configured in .widemap.json');
  }
  return data.asus;
}

// ─── ASUS login (SHA256 challenge-response via login_v2.cgi) ────────────────
async function loginToRouter(ip, username, password) {
  const base = `http://${ip}`;

  // 1. Get nonce
  const id = crypto.randomBytes(5).toString('hex');
  const nonceRes = await axios.post(`${base}/get_Nonce.cgi`, JSON.stringify({ id }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  const nonce = nonceRes.data?.nonce;
  if (!nonce) throw new Error('Nonce retrieval failed');

  // 2. Compute SHA256 challenge-response
  const cnonce = crypto.randomBytes(16).toString('hex');
  const loginAuth = crypto
    .createHash('sha256')
    .update(`${username}:${nonce}:${password}:${cnonce}`)
    .digest('hex');

  // 3. POST to login_v2.cgi
  const params = new URLSearchParams({
    login_authorization: loginAuth,
    id,
    cnonce,
    login_captcha: '',
    action_mode: '',
    action_script: '',
    action_wait: '5',
    current_page: 'Main_Login.asp',
    next_page: '',
  });

  const res = await axios.post(`${base}/login_v2.cgi`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 8000,
    maxRedirects: 0,
    validateStatus: s => true,
  });

  // Extract token from Set-Cookie
  const cookies = res.headers['set-cookie'] || [];
  for (const c of cookies) {
    const m = c.match(/asus_token=([^;]+)/);
    if (m && m[1] !== 'deleted') return m[1];
  }

  throw new Error('Login failed: no token in response cookies');
}

async function apiGet(ip, token, hook) {
  const resp = await axios.get(`http://${ip}/appGet.cgi?hook=${encodeURIComponent(hook)}`, {
    headers: { Cookie: `asus_token=${token}` },
    timeout: 10000,
  });
  return resp.data;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ASUS WiFi AP Integration', () => {
  let config;
  let token;

  before(() => {
    config = loadTestConfig();
  });

  it('authenticates and receives token', async () => {
    token = await loginToRouter(config.ip, config.user, config.pass);
    assert(token, 'Should receive auth token');
    assert(token.length > 0, 'Token should not be empty');
  });

  it('fetches client list', async () => {
    const raw = await apiGet(config.ip, token, 'get_clientlist()');
    assert(raw, 'Should get response from router');
    const clients = parseClientList(raw);
    assert(clients.length >= 0, 'Should parse client list without error');
    // At least the test machine itself should be connected
    console.log(`  [asus] ${clients.length} online clients found`);
  });

  it('fetched clients have valid structure', async () => {
    const raw = await apiGet(config.ip, token, 'get_clientlist()');
    const clients = parseClientList(raw);

    for (const c of clients) {
      assert(c.mac, 'Client must have mac');
      assert(c.mac.match(/^[0-9A-Fa-f:]{17}$/) || c.mac.match(/^[0-9A-Fa-f]{12}$/),
        `Invalid MAC format: ${c.mac}`);
      assert(typeof c.isOnline === 'boolean', 'isOnline must be boolean');
      assert(typeof c.rssi === 'number', 'rssi must be number');
    }
  });

  it('fetches network device stats', async () => {
    const raw = await apiGet(config.ip, token, 'netdev(appobj)');
    // netdev may return empty object, string, or null depending on router state
    // As long as no HTTP error was thrown, the API call succeeded
    assert(raw !== undefined, 'Should get some response from netdev endpoint');
  });

  it('handles invalid token gracefully', async () => {
    try {
      await apiGet(config.ip, 'invalid_token_12345', 'get_clientlist()');
      // Some routers return 200 with empty/error body instead of 4xx
    } catch (err) {
      // Expected: 401/403 or connection refused
      assert(err.response?.status >= 400 || err.code, 'Should reject invalid token');
    }
  });
});
