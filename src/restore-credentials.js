'use strict';

// What a restore takes from the backup, and what it keeps from the Hub it
// replaces (P2-102 H2).
//
// A backup is a whole database, and two of its tables are credentials: the
// API tokens (`api_identities`) and the login sessions (`sessions`). Both are
// stored as a plain SHA-256 of the secret, so anyone who can hand an operator
// a backup to restore can put in the hash of a token they hold -- and after
// the restore, hold an administrator's token on that Hub. A restore is for
// going back to earlier data. Who may sign in is not data to go back on, so
// those two tables are taken from the Hub being replaced, not from the file.
//
// The Hub's schema has no triggers or views. A backup that has one is not a
// Hub backup as this Hub wrote it, and a trigger would run on the Hub's own
// writes from then on (it could, for one, empty the audit trail as it fills),
// so such a file is refused.
//
// Applied to the working copy of the backup, never to the backup itself.

const Database = require('better-sqlite3');

const CREDENTIAL_TABLES = ['api_identities', 'sessions'];

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
}

/**
 * @param {string} copyPath the working copy that is about to replace the Hub's database
 * @param {{ credentialSource: string|null }} options a copy of the database
 *   being replaced, or null when there is none (a Hub with no database yet)
 */
function prepareRestoredCopy(copyPath, { credentialSource = null } = {}) {
  const db = new Database(copyPath, { fileMustExist: true });
  try {
    const unexpected = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY type, name"
    ).all();
    if (unexpected.length) {
      const listed = unexpected.slice(0, 5).map(item => `${item.type} ${item.name}`).join(', ');
      throw new Error(`The backup contains ${listed}; a Hub database has none, so it is not restored`);
    }

    const tables = tableNames(db);
    let source = null;
    try {
      source = credentialSource ? new Database(credentialSource, { readonly: true, fileMustExist: true }) : null;
      const sourceTables = source ? tableNames(source) : new Set();
      db.transaction(() => {
        for (const table of CREDENTIAL_TABLES) {
          if (!tables.has(table)) continue;
          // The file's rows never survive. With no Hub to take them from, the
          // restored Hub starts with no API tokens and nobody signed in; the
          // administrator signs in with the password and issues tokens again.
          db.prepare(`DELETE FROM ${table}`).run();
          if (!source || !sourceTables.has(table)) continue;
          const keep = columnNames(db, table);
          const shared = columnNames(source, table).filter(column => keep.includes(column));
          if (!shared.length) continue;
          const list = shared.join(', ');
          const insert = db.prepare(`INSERT INTO ${table} (${list}) VALUES (${shared.map(() => '?').join(', ')})`);
          for (const row of source.prepare(`SELECT ${list} FROM ${table}`).raw().all()) insert.run(...row);
        }
      })();
    } finally {
      source?.close();
    }
    // Leave nothing beside the file: it is renamed into place next, and a
    // -wal left behind would be replayed into whatever sits at that path.
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } finally {
    db.close();
  }
}

module.exports = { prepareRestoredCopy, CREDENTIAL_TABLES };
