#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const authPassword = require('../src/auth-password');
const configIo = require('../src/config');

function resolvePaths() {
  const configPath = process.env.EGRESSVIEW_CONFIG_PATH
    ? path.resolve(process.env.EGRESSVIEW_CONFIG_PATH)
    : configIo.DEFAULT_CONFIG_FILE;
  const dbPath = process.env.EGRESSVIEW_DB_PATH
    ? path.resolve(process.env.EGRESSVIEW_DB_PATH)
    : path.resolve(process.env.EGRESSVIEW_DB || '.egressview.db');
  return { configPath, dbPath };
}

function reset({ configPath, dbPath, regenerateApiToken = false }) {
  const config = configIo.loadFileOrThrow(configPath);
  const password = authPassword.generateInitialPassword();
  const hashed = authPassword.hashPassword(password);
  config.auth = {
    ...(config.auth || {}),
    passwordHash: hashed.hash,
    salt: hashed.salt,
    password: hashed.record,
  };
  let apiToken = null;
  if (regenerateApiToken) {
    apiToken = crypto.randomBytes(24).toString('hex');
    config.adminToken = apiToken;
  }
  // Revoke first. If the config write fails afterward, the old password stays
  // valid but every browser session is safely logged out.
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath);
    try {
      const hasSessions = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
      ).get();
      if (hasSessions) db.prepare('DELETE FROM sessions').run();
    } finally {
      db.close();
    }
  }
  configIo.saveFile(config, configPath);
  return { password, apiToken };
}

function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('Refusing to reset credentials without an interactive TTY.\n');
    process.exitCode = 1;
    return;
  }
  const regenerateApiToken = process.argv.includes('--regenerate-api-token');
  const paths = resolvePaths();
  const result = reset({ ...paths, regenerateApiToken });
  process.stdout.write('\nCredentials were reset and all browser sessions were revoked.\n');
  process.stdout.write(`New login password (shown once): ${result.password}\n`);
  if (result.apiToken) {
    process.stdout.write(`New admin API token (shown once): ${result.apiToken}\n`);
  }
  process.stdout.write('\nStore these values in a password manager before closing this terminal.\n');
}

if (require.main === module) main();

module.exports = { reset, resolvePaths };
