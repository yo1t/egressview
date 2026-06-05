// Integration tests for Yamaha RTX SSH connection (requires real hardware)
// Run: node --test test/integration/yamaha.test.js
// Requires: .widemap.json with valid yamaha credentials
//
// SECURITY NOTE:
// - Credentials are read from .widemap.json (gitignored, 0600 permissions)
// - No credentials are logged or written to test output
// - Baseline file contains only aggregate metrics (no IP addresses or session details)

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');

const CONFIG_FILE = path.join(__dirname, '..', '..', '.widemap.json');
const BASELINE_FILE = path.join(__dirname, '..', 'fixtures', 'baseline.json');

// ─── Re-implement parseNatDetail (same as server.js) ────────────────────────
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

// ─── Load config (credentials) ──────────────────────────────────────────────
function loadTestConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Config file not found: ${CONFIG_FILE} — integration tests require .widemap.json`);
  }
  const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!data.yamaha?.ip || !data.yamaha?.user || !data.yamaha?.pass) {
    throw new Error('Yamaha credentials not configured in .widemap.json');
  }
  return data.yamaha;
}

// ─── SSH connect helper ─────────────────────────────────────────────────────
function sshConnect(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    conn.connect({
      host: config.ip,
      port: 22,
      username: config.user,
      password: config.pass,
      readyTimeout: 15000,
      hostVerifier: () => true,
    });
  });
}

// ─── SSH shell exec (Yamaha uses interactive shell, not exec) ───────────────
// Yamaha RTX sends prompt like "RTX1300> " after command output.
// Large outputs are paginated with "---つづく---" (press space to continue).
function sshShellExec(conn, cmd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let cmdSent = false;
    let cmdOutput = '';
    const timer = setTimeout(() => {
      try { conn.end(); } catch {}
      reject(new Error(`SSH shell timeout: ${cmd}`));
    }, timeoutMs);

    conn.shell((err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }

      stream.on('data', (d) => {
        buf += d.toString();

        if (!cmdSent) {
          // Wait for initial prompt
          if (buf.endsWith('> ')) {
            buf = '';
            cmdSent = true;
            stream.write(cmd + '\n');
          }
        } else {
          // Handle pagination: send space to get next page
          if (buf.includes('---つづく---') || buf.includes('--- more ---')) {
            buf = buf.replace(/---つづく---/g, '').replace(/--- more ---/g, '');
            stream.write(' ');
          }
          // After command sent, wait for next prompt
          if (buf.endsWith('> ')) {
            clearTimeout(timer);
            cmdOutput = buf;
            stream.end();
          }
        }
      });

      stream.on('close', () => {
        clearTimeout(timer);
        resolve(cmdOutput || buf);
      });
    });
  });
}

// ─── Baseline management ────────────────────────────────────────────────────
function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveBaseline(metrics) {
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(metrics, null, 2));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Yamaha RTX Integration', () => {
  let config;

  it('loads config', () => {
    config = loadTestConfig();
    assert(config.ip, 'Should have Yamaha IP');
  });

  it('connects via SSH', async () => {
    const conn = await sshConnect(config);
    assert(conn, 'SSH connection should be established');
    conn.end();
  });

  it('executes show command and gets output', async () => {
    const conn = await sshConnect(config);
    const output = await sshShellExec(conn, 'show environment');
    conn.end();
    assert(output.length > 0, 'Should get non-empty output');
  });

  it('fetches NAT table and parses sessions', async () => {
    const conn = await sshConnect(config);
    const natNum = config.nat || '100';
    const output = await sshShellExec(conn, `show nat descriptor address ${natNum} detail`, 60000);
    conn.end();

    assert(output.length > 0, 'NAT output should not be empty');

    const sessions = parseNatDetail(output);
    assert(sessions.length > 0, `Should parse at least 1 session, got ${sessions.length}`);

    // Structural validation: every session has required fields
    for (const s of sessions) {
      assert(s.proto, 'Session must have proto');
      assert(s.src, 'Session must have src');
      assert(typeof s.sport === 'number', 'Session must have numeric sport');
      assert(s.dst, 'Session must have dst');
      assert(typeof s.dport === 'number', 'Session must have numeric dport');
      assert(typeof s.ttl === 'number', 'Session must have numeric ttl');
    }

    console.log(`  [yamaha] Parsed ${sessions.length} NAT sessions`);
  });

  it('NAT session count matches baseline (±50%)', async () => {
    const conn = await sshConnect(config);
    const natNum = config.nat || '100';
    const output = await sshShellExec(conn, `show nat descriptor address ${natNum} detail`, 60000);
    conn.end();

    const sessions = parseNatDetail(output);

    const metrics = {
      sessions: sessions.length,
      uniqueSrc: new Set(sessions.map(s => s.src)).size,
      uniqueDst: new Set(sessions.map(s => s.dst)).size,
      timestamp: new Date().toISOString(),
    };

    const updateBaseline = process.argv.includes('--update-baseline');
    const baseline = loadBaseline();

    if (!baseline || updateBaseline) {
      saveBaseline(metrics);
      if (!baseline) {
        console.log(`  [baseline] Created initial baseline: ${metrics.sessions} sessions, ${metrics.uniqueSrc} src, ${metrics.uniqueDst} dst`);
      } else {
        console.log(`  [baseline] Updated: ${metrics.sessions} sessions (was ${baseline.sessions})`);
      }
      return; // Skip comparison on first run / update
    }

    // Compare with baseline (±50% tolerance)
    const tolerance = 0.5;
    const minSessions = Math.floor(baseline.sessions * tolerance);
    const maxSessions = Math.ceil(baseline.sessions * (1 + tolerance));

    assert(
      metrics.sessions >= minSessions,
      `Session count ${metrics.sessions} is below baseline minimum ${minSessions} (baseline: ${baseline.sessions})`
    );
    assert(
      metrics.sessions <= maxSessions,
      `Session count ${metrics.sessions} is above baseline maximum ${maxSessions} (baseline: ${baseline.sessions})`
    );

    assert(
      metrics.uniqueSrc >= Math.floor(baseline.uniqueSrc * tolerance),
      `Unique source count ${metrics.uniqueSrc} dropped significantly (baseline: ${baseline.uniqueSrc})`
    );

    console.log(`  [baseline] OK: ${metrics.sessions} sessions (baseline: ${baseline.sessions}, range: ${minSessions}-${maxSessions})`);
  });

  it('reconnects after forced disconnect', async () => {
    const conn1 = await sshConnect(config);
    // Force destroy (simulates network cut)
    conn1.destroy();

    // Wait, then reconnect
    await new Promise(r => setTimeout(r, 2000));

    const conn2 = await sshConnect(config);
    const output = await sshShellExec(conn2, 'show environment');
    conn2.end();

    assert(output.length > 0, 'Should get output after reconnection');
  });
});
