#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const checks = [
  ['private key', /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Agent bearer', /\begva_[A-Za-z0-9_-]{20,}\b/],
  ['environment-specific LAN IP', /\b(?:10\.41\.128|192\.168\.41)\.\d{1,3}\b/],
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function trackedDatabases() {
  return execFileSync('git', ['ls-files', '*.db', '*.sqlite'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const findings = [];
for (const file of trackedDatabases()) {
  if (!fs.existsSync(file)) continue;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      findings.push({ file, location: 'database', name: 'integrity check failed' });
      continue;
    }
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
    for (const { name: table } of tables) {
      const columns = db.pragma(`table_info(${quoteIdentifier(table)})`)
        .filter(column => /TEXT|CHAR|CLOB|BLOB/i.test(column.type || ''));
      if (!columns.length) continue;
      const selected = columns.map(column => quoteIdentifier(column.name)).join(', ');
      const rows = db.prepare(`SELECT rowid AS __rowid, ${selected} FROM ${quoteIdentifier(table)}`).iterate();
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column.name];
          if (value === null || value === undefined) continue;
          const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
          for (const [checkName, pattern] of checks) {
            if (pattern.test(text)) {
              findings.push({
                file,
                location: `${table}.${column.name} rowid=${row.__rowid}`,
                name: checkName,
              });
            }
          }
        }
      }
    }
  } finally {
    db.close();
  }
}

if (findings.length) {
  console.error('Tracked database secret scan failed:');
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.location} [${finding.name}]`);
  }
  process.exit(1);
}

console.log(`Tracked database secret scan passed (${trackedDatabases().length} database file(s)).`);
