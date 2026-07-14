#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const pkg = require('../package.json');
const { checkObservationConsistency } = require('../src/observation-consistency');
const { DAY_MS, createSoakRecord, summarizeSoakHistory } = require('../src/soak-observation');

const APP_ROOT = path.join(__dirname, '..');
const dbPath = path.resolve(process.env.EGRESSVIEW_DB_PATH || process.env.EGRESSVIEW_DB || path.join(APP_ROOT, '.egressview.db'));
const outputPath = path.resolve(process.env.EGRESSVIEW_SOAK_OUTPUT || path.join(APP_ROOT, '.egressview-soak.jsonl'));
const baseUrl = String(process.env.EGRESSVIEW_SOAK_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const token = process.env.EGRESSVIEW_SOAK_TOKEN || '';
const commit = process.env.EGRESSVIEW_BUILD_COMMIT || '';
const requiredKinds = String(process.env.EGRESSVIEW_SOAK_REQUIRED_KINDS || 'yamaha,cisco')
  .split(',').map(value => value.trim()).filter(Boolean);
const recentHours = Number(process.env.EGRESSVIEW_SOAK_RECENT_HOURS || 24);

function assertSafeApiUrl(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('EGRESSVIEW_SOAK_URL must use HTTPS unless it points to localhost');
  }
  return url;
}

async function fetchRouterStatus() {
  if (!token) throw new Error('EGRESSVIEW_SOAK_TOKEN is required');
  const url = assertSafeApiUrl(`${baseUrl}/api/routers`);
  const response = await fetch(url, {
    headers: { 'X-Admin-Token': token, Accept: 'application/json', Connection: 'close' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`router status API returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body.routers)) throw new Error('router status API returned an invalid response');
  return { routers: body.routers, processStartedAt: body.processStartedAt };
}

function appendRecord(record) {
  fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
}

function readRecords() {
  return fs.readFileSync(outputPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function main() {
  const startedAt = Date.now();
  let db;
  try {
    const status = await fetchRouterStatus();
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 10000');
    const consistency = checkObservationConsistency(db, startedAt);
    const record = createSoakRecord({
      consistency,
      routers: status.routers,
      version: pkg.version,
      commit,
      durationMs: Date.now() - startedAt,
      now: startedAt,
      recentWindowMs: Number.isFinite(recentHours) && recentHours > 0 ? recentHours * 60 * 60 * 1000 : DAY_MS,
      requiredKinds,
      processStartedAt: status.processStartedAt,
    });
    appendRecord(record);
    const summary = summarizeSoakHistory(readRecords());
    process.stdout.write(`[soak] ${record.passed ? 'OK' : 'FAILED'} ${JSON.stringify({ record, summary })}\n`);
    process.exitCode = record.passed ? 0 : 1;
  } catch (err) {
    const record = {
      checkedAt: new Date(startedAt).toISOString(),
      version: pkg.version,
      commit: commit || 'unknown',
      durationMs: Date.now() - startedAt,
      passed: false,
      failures: [String(err?.message || err).slice(0, 300)],
    };
    try { appendRecord(record); } catch (writeErr) {
      process.stderr.write(`[soak] could not write result: ${writeErr.message}\n`);
    }
    process.stderr.write(`[soak] FAILED ${JSON.stringify(record)}\n`);
    process.exitCode = 1;
  } finally {
    try { db?.close(); } catch {}
  }
}

main();
