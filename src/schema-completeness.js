'use strict';

/**
 * Says out loud when the database is missing something (P2-97).
 *
 * `integrity_check` reads the file's internal structure. It does not look at
 * whether a table exists: measured 2026-08-29, a database with `audit_events`
 * dropped reports `ok`. So the Hub starts, `/readyz` answers 200, and the
 * first attempt to record an audit event fails with `no such table`.
 *
 * Migrations do not cover this either. They never run again once
 * `user_version` reaches the current version, and the schema statements
 * `initDb` runs afterwards happen to restore 13 of 48 objects -- an accident
 * of what was written there, not a design. `audit_events`, `api_identities`
 * and `agents` are among the 35 it does not restore.
 *
 * **This only reports.** It does not repair, refuse to start, or fail
 * readiness. Recreating a missing table would hand back an empty one and
 * present data loss as a working system; failing readiness would take a Hub
 * offline for a fault it may be able to work around. What changes is that the
 * fault is stated at startup instead of surfacing later as a query error
 * nobody connects to the schema.
 *
 * The deploy script counts ERROR lines after start, so a missing object fails
 * deploy verification and rolls back.
 */

/**
 * The objects a database at the current schema version should hold.
 *
 * Built by migrating an empty database rather than read from a list. A
 * hand-written list drifts from what the migrations actually create, and
 * silently: `APP_SCRIPT_FILES` in the frontend lint had two modules missing
 * for months, and nothing reported them -- they were simply never checked.
 *
 * Measured 2026-08-29: 12 ms for 42 objects.
 */
function expectedObjects(Database, runMigrations, sourceRouterMap) {
  const reference = new Database(':memory:');
  try {
    runMigrations(reference, ':memory:', { sourceRouterMap });
    return reference
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => `${row.type}:${row.name}`);
  } finally {
    try { reference.close(); } catch { /* nothing left to do */ }
  }
}

function actualObjects(db) {
  return new Set(
    db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => `${row.type}:${row.name}`)
  );
}

/**
 * @returns {{ missing: string[], expected: number }}
 */
function findMissingObjects({ db, Database, runMigrations, sourceRouterMap = {} }) {
  const expected = expectedObjects(Database, runMigrations, sourceRouterMap);
  const present = actualObjects(db);
  return { missing: expected.filter((name) => !present.has(name)), expected: expected.length };
}

/**
 * Reports what is missing, and never throws.
 *
 * A check that can take the Hub down is worse than the fault it looks for: the
 * point is to say something, and saying nothing quietly is what this exists to
 * stop. A failure inside the check is itself reported.
 */
function reportSchemaCompleteness({
  db, Database, runMigrations, sourceRouterMap = {}, logger = console, version,
}) {
  try {
    const { missing, expected } = findMissingObjects({
      db, Database, runMigrations, sourceRouterMap,
    });
    if (!missing.length) return { missing: [], expected };
    // Named, not counted. "3 objects are missing" sends someone looking; the
    // names tell them whether it is an index they can live without or the
    // audit table.
    logger.error(
      `[history] Database reports schema version ${version} but `
      + `${missing.length} of ${expected} objects are missing: ${missing.join(', ')}. `
      + 'Nothing here recreates them: an empty replacement would present data loss '
      + 'as a working system. Restore from a backup, or accept the loss knowingly.'
    );
    return { missing, expected };
  } catch (error) {
    logger.error(`[history] Could not check the schema for missing objects: ${error.message}`);
    return { missing: [], expected: 0, checkFailed: true };
  }
}

module.exports = { findMissingObjects, reportSchemaCompleteness };
