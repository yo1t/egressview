#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { installRelease, status } = require('./offline-install');
const { assertSafeRelativePath } = require('./offline-bundle-lib');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${argv[i] || ''}`);
    }
    options[argv[i].slice(2)] = path.resolve(argv[++i]);
  }
  if (!options.artifact) throw new Error('--artifact is required');
  return options;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Installed server exited early:\n${child.output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Installed server did not become ready:\n${child.output}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function check(options) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'egressview-offline-install-'));
  try {
    const listing = require('node:child_process')
      .execFileSync('tar', ['-tzf', options.artifact], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const entry of listing) {
      const relative = entry.replace(/^[^/]+\/?/, '').replace(/\/$/, '');
      if (relative) assertSafeRelativePath(relative);
    }
    require('node:child_process').execFileSync('tar', ['-xzf', options.artifact, '-C', temp]);
    const roots = fs.readdirSync(temp);
    if (roots.length !== 1) throw new Error('Offline artifact must have one root directory');
    const bundleRoot = path.join(temp, roots[0]);
    const prefix = path.join(temp, 'installation');
    installRelease({ bundleRoot, prefix });
    const installed = status(prefix);
    if (!installed.current) throw new Error('Offline installation did not create current release');

    const current = path.resolve(prefix, installed.current);
    if (!fs.existsSync(path.join(current, 'node_modules', 'better-sqlite3'))) {
      throw new Error('Offline installation is missing production dependencies');
    }
    const config = path.join(temp, 'config.json');
    const database = path.join(temp, 'runtime.db');
    const backups = path.join(temp, 'backups');
    fs.writeFileSync(config, '{}\n', { mode: 0o600 });
    const port = await unusedPort();
    const networkGuard = path.resolve(__dirname, '../test/fixtures/deny-external-network.js');
    const egressAudit = path.join(temp, 'egress-audit.jsonl');
    const nodeOptions = fs.existsSync(networkGuard)
      ? [process.env.NODE_OPTIONS, `--require=${networkGuard}`].filter(Boolean).join(' ')
      : process.env.NODE_OPTIONS;
    const child = spawn(process.execPath, [path.join(current, 'server.js')], {
      cwd: current,
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        DEMO_MODE: 'true',
        DEMO_ADMIN_TOKEN: 'offline-artifact-gate-token',
        EGRESSVIEW_OFFLINE_MODE: 'true',
        EGRESSVIEW_CONFIG_PATH: config,
        EGRESSVIEW_DB_PATH: database,
        EGRESSVIEW_BACKUP_DIR: backups,
        HOST: '127.0.0.1',
        PORT: String(port),
        AWS_EC2_METADATA_DISABLED: 'true',
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
        EGRESSVIEW_EGRESS_AUDIT_PATH: egressAudit,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.output = '';
    child.stdout.on('data', (chunk) => { child.output += chunk; });
    child.stderr.on('data', (chunk) => { child.output += chunk; });
    try {
      await waitFor(`http://127.0.0.1:${port}/readyz`, child);
      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { 'X-Admin-Token': 'offline-artifact-gate-token' },
      });
      const body = await statusResponse.json();
      if (!statusResponse.ok || body.offlineMode !== true) {
        throw new Error('Installed server did not report offline mode');
      }
      if (fs.existsSync(egressAudit) && fs.statSync(egressAudit).size > 0) {
        throw new Error(`Installed server attempted external access:\n${
          fs.readFileSync(egressAudit, 'utf8')
        }`);
      }
    } finally {
      await stopChild(child);
    }
    return installed;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  check(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify({ checked: true, ...result })}\n`))
    .catch((error) => {
      process.stderr.write(`Offline artifact check failed: ${error.message}\n`);
      process.exit(1);
    });
}

module.exports = { check, parseArgs, stopChild };
