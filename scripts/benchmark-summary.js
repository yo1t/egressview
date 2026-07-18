'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');

const generateIndex = process.argv.indexOf('--generate');
const generatedRows = generateIndex >= 0 ? Number(process.argv[generateIndex + 1] || 100_000) : 0;
const dbPath = generatedRows
  ? ':memory:'
  : path.resolve(process.argv[2] || process.env.EGRESSVIEW_DB_PATH || '.egressview.db');
const db = generatedRows
  ? new Database(':memory:')
  : new Database(dbPath, { readonly: true, fileMustExist: true });
const target = "COALESCE(NULLIF(org, ''), NULLIF(dstHost, ''), dst)";
const sql = `SELECT ${target} AS key, lat, lon, COUNT(*) AS totalSessions,
  COUNT(*) OVER () AS totalGroups, SUM(COUNT(*)) OVER () AS allLocationSessions
  FROM connections WHERE lat IS NOT NULL AND lon IS NOT NULL
  GROUP BY key, lat, lon ORDER BY totalSessions DESC LIMIT 500`;

try {
  if (generatedRows) {
    db.exec(`CREATE TABLE connections (
      org TEXT, dstHost TEXT, dst TEXT, lat REAL, lon REAL
    )`);
    const insert = db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let index = 0; index < generatedRows; index++) {
        const group = index % 2_000;
        insert.run(`Org ${group}`, '', `198.51.${group % 255}.${index % 255}`, 20 + (group % 60), 120 + (group % 40));
      }
    })();
  }
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  const startedAt = process.hrtime.bigint();
  const rows = db.prepare(sql).all();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  process.stdout.write(JSON.stringify({
    dbPath,
    connections: db.prepare('SELECT COUNT(*) AS count FROM connections').get().count,
    generated: generatedRows > 0,
    locationGroups: rows[0]?.totalGroups || 0,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    plan,
  }, null, 2) + '\n');
} finally {
  db.close();
}
