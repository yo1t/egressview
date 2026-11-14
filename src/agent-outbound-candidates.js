'use strict';

// What a Mac Agent found worth a look against its own usual traffic over the
// last 14 days, and what the person at that Mac answered (P3-192, P3-193,
// P3-194). Sent only when the person turns it on in the Agent's settings; the
// note comes only with a second, separate switch.
//
// The Agent sends the whole list each time and this replaces what was held
// for that Agent, so a candidate that left the list, an answer taken back, or
// a note no longer shared disappears here too. Turning sharing off sends an
// empty list with `sharing: false`, which deletes this Agent's rows.
//
// Kept in a table created here rather than by a schema migration, as
// agent-inbound-probes.js explains: a migration on this Hub begins with a
// verified copy of the whole database.

const { z } = require('zod');

// The Agent's own list stops at 20, and the Hub reads JSON bodies outside
// ingest at up to 64 KB: 20 entries with the longest names and notes fit.
const MAX_ENTRIES = 20;
const NAME_LIMIT = 255;
const NOTE_LIMIT = 500;
// The Agent lists 14 days; an answer it still holds can be up to 30 days
// older than that. Rows past both are pruned even if an Agent stopped
// sending.
const RETENTION_MS = 44 * 24 * 60 * 60 * 1000;

const isoDate = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)), 'invalid date');

const entrySchema = z.object({
  candidateId: z.string().min(1).max(600),
  kind: z.enum(['newPair', 'aboveUsual', 'machine']),
  day: isoDate,
  application: z.string().max(NAME_LIMIT).nullable().optional(),
  destination: z.string().max(NAME_LIMIT).nullable().optional(),
  bytesOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  usualBytesOut: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  answer: z.enum(['expected', 'investigate']).nullable().optional(),
  answeredAt: isoDate.nullable().optional(),
  note: z.string().max(NOTE_LIMIT).nullable().optional(),
}).strict();

const outboundCandidatesSchema = z.object({
  schemaVersion: z.literal(1),
  sharing: z.boolean(),
  generatedAt: isoDate,
  state: z.enum(['learning', 'lowByteCoverage', 'ready']).nullable().optional(),
  total: z.number().int().nonnegative().max(1_000_000),
  entries: z.array(entrySchema).max(MAX_ENTRIES),
}).strict().superRefine((value, context) => {
  if (!value.sharing && value.entries.length > 0) {
    context.addIssue({ code: 'custom', message: 'entries must be empty when sharing is off' });
  }
});

function ensureOutboundCandidatesTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_outbound_candidates (
      agentId TEXT NOT NULL,
      candidateId TEXT NOT NULL,
      kind TEXT NOT NULL,
      day INTEGER NOT NULL,
      application TEXT,
      destination TEXT,
      bytesOut INTEGER NOT NULL,
      usualBytesOut INTEGER,
      answer TEXT,
      answeredAt INTEGER,
      note TEXT,
      receivedAt INTEGER NOT NULL,
      PRIMARY KEY (agentId, candidateId)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_outbound_candidates_day ON agent_outbound_candidates(day);
    CREATE TABLE IF NOT EXISTS agent_outbound_candidate_reports (
      agentId TEXT PRIMARY KEY,
      state TEXT,
      total INTEGER NOT NULL,
      generatedAt INTEGER NOT NULL,
      receivedAt INTEGER NOT NULL
    );
  `);
}

/** Replaces everything held for this Agent with what it just sent. */
function replaceOutboundCandidates(db, agentId, payload, { receivedAt = Date.now() } = {}) {
  const remove = db.prepare('DELETE FROM agent_outbound_candidates WHERE agentId = ?');
  const removeReport = db.prepare('DELETE FROM agent_outbound_candidate_reports WHERE agentId = ?');
  const insert = db.prepare(`
    INSERT INTO agent_outbound_candidates (
      agentId, candidateId, kind, day, application, destination, bytesOut,
      usualBytesOut, answer, answeredAt, note, receivedAt
    ) VALUES (
      @agentId, @candidateId, @kind, @day, @application, @destination, @bytesOut,
      @usualBytesOut, @answer, @answeredAt, @note, @receivedAt
    )
    ON CONFLICT (agentId, candidateId) DO NOTHING
  `);
  const report = db.prepare(`
    INSERT INTO agent_outbound_candidate_reports (agentId, state, total, generatedAt, receivedAt)
    VALUES (?, ?, ?, ?, ?)
  `);
  let stored = 0;
  db.transaction(() => {
    remove.run(agentId);
    removeReport.run(agentId);
    if (!payload.sharing) return;
    report.run(agentId, payload.state ?? null, payload.total, Date.parse(payload.generatedAt), receivedAt);
    for (const entry of payload.entries) {
      const note = typeof entry.note === 'string' ? entry.note.trim() : '';
      stored += insert.run({
        agentId,
        candidateId: entry.candidateId,
        kind: entry.kind,
        day: Date.parse(entry.day),
        application: entry.application ?? null,
        destination: entry.destination ?? null,
        bytesOut: entry.bytesOut,
        usualBytesOut: entry.usualBytesOut ?? null,
        answer: entry.answer ?? null,
        answeredAt: entry.answer && entry.answeredAt ? Date.parse(entry.answeredAt) : null,
        note: entry.answer && note ? note : null,
        receivedAt,
      }).changes;
    }
  })();
  return { stored, sharing: payload.sharing };
}

/** Every Agent's list, newest day first, for the Hub's screen. */
function listOutboundCandidates(db) {
  const reports = db.prepare(`
    SELECT agentId, state, total, generatedAt, receivedAt FROM agent_outbound_candidate_reports
  `).all();
  const rows = db.prepare(`
    SELECT agentId, candidateId, kind, day, application, destination, bytesOut, usualBytesOut,
           answer, answeredAt, note
    FROM agent_outbound_candidates
    ORDER BY day DESC, agentId, candidateId
  `).all();
  const byAgent = new Map(reports.map(report => [report.agentId, { ...report, entries: [] }]));
  for (const row of rows) {
    const agent = byAgent.get(row.agentId);
    if (!agent) continue;
    agent.entries.push({
      candidateId: row.candidateId,
      kind: row.kind,
      day: row.day,
      application: row.application,
      destination: row.destination,
      bytesOut: row.bytesOut,
      usualBytesOut: row.usualBytesOut,
      answer: row.answer,
      answeredAt: row.answeredAt,
      note: row.note,
    });
  }
  return [...byAgent.values()];
}

/**
 * Drops what an Agent can no longer be holding. A removed Agent's rows are
 * not listed (the route shows only enrolled Agents) and go with age.
 */
function pruneOutboundCandidates(db, { now = Date.now() } = {}) {
  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_outbound_candidates'"
  ).get();
  if (!hasTable) return 0;
  const cutoff = now - RETENTION_MS;
  const removed = db.prepare('DELETE FROM agent_outbound_candidates WHERE day < ?').run(cutoff).changes;
  db.prepare('DELETE FROM agent_outbound_candidate_reports WHERE receivedAt < ?').run(cutoff);
  return removed;
}

module.exports = {
  MAX_ENTRIES,
  NOTE_LIMIT,
  RETENTION_MS,
  outboundCandidatesSchema,
  ensureOutboundCandidatesTables,
  replaceOutboundCandidates,
  listOutboundCandidates,
  pruneOutboundCandidates,
};
