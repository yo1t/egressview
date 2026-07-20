'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const Database = require('better-sqlite3');
const { SCHEMA_VERSION } = require('../../src/db-migrate');

const DEMO_DB_PATH = path.join(__dirname, '..', '..', '.egressview.demo.db');

describe('committed demo database', () => {
  it('is healthy and already uses the current schema', () => {
    const db = new Database(DEMO_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    } finally {
      db.close();
    }
  });
});
