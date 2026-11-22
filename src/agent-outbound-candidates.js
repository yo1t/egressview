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
// An administrator can also answer on the Hub (P3-194 stage 2). Those
// answers live in a table of their own so that the Agent's next send, which
// replaces its rows, cannot wipe them. On screen the newer of the two answers
// wins. The Agent learns of a Hub answer within seconds: each ingest reply
// carries this Agent's answer version, and an Agent that sees it change asks
// for the answers. Once the Agent sends back an answer at least as new, the
// Hub's row has done its job and is dropped.
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
  // Whether the person also shares notes. Agents before P3-194 stage 2 do
  // not say; the Hub then keeps its own notes to itself.
  notesShared: z.boolean().optional(),
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
    CREATE TABLE IF NOT EXISTS agent_outbound_candidate_hub_answers (
      agentId TEXT NOT NULL,
      candidateId TEXT NOT NULL,
      answer TEXT,
      note TEXT,
      answeredAt INTEGER NOT NULL,
      answeredBy TEXT,
      PRIMARY KEY (agentId, candidateId)
    );
    CREATE TABLE IF NOT EXISTS agent_outbound_candidate_answer_versions (
      agentId TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    );
  `);
  const reportColumns = db.prepare('PRAGMA table_info(agent_outbound_candidate_reports)').all()
    .map(column => column.name);
  if (!reportColumns.includes('notesShared')) {
    db.exec('ALTER TABLE agent_outbound_candidate_reports ADD COLUMN notesShared INTEGER');
  }
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
    INSERT INTO agent_outbound_candidate_reports (agentId, state, total, generatedAt, receivedAt, notesShared)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const hubAnswers = db.prepare(
    'SELECT candidateId, answeredAt FROM agent_outbound_candidate_hub_answers WHERE agentId = ?'
  );
  const dropHubAnswer = db.prepare(
    'DELETE FROM agent_outbound_candidate_hub_answers WHERE agentId = ? AND candidateId = ?'
  );
  let stored = 0;
  db.transaction(() => {
    remove.run(agentId);
    removeReport.run(agentId);
    const sent = new Map();
    if (payload.sharing) {
      for (const entry of payload.entries) {
        sent.set(entry.candidateId, entry.answeredAt ? Date.parse(entry.answeredAt) : null);
      }
    }
    // A Hub answer goes once the Agent has one at least as new (it took the
    // Hub's, or the person answered again since), or once the candidate is
    // gone from the list.
    for (const held of hubAnswers.all(agentId)) {
      if (!sent.has(held.candidateId)) {
        dropHubAnswer.run(agentId, held.candidateId);
        continue;
      }
      const agentAt = sent.get(held.candidateId);
      if (agentAt !== null && agentAt >= held.answeredAt) dropHubAnswer.run(agentId, held.candidateId);
    }
    if (!payload.sharing) return;
    report.run(agentId, payload.state ?? null, payload.total, Date.parse(payload.generatedAt), receivedAt,
      payload.notesShared === undefined ? null : (payload.notesShared ? 1 : 0));
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
    SELECT agentId, state, total, generatedAt, receivedAt, notesShared FROM agent_outbound_candidate_reports
  `).all();
  const hub = new Map(db.prepare(`
    SELECT agentId, candidateId, answer, note, answeredAt FROM agent_outbound_candidate_hub_answers
  `).all().map(row => [`${row.agentId}\n${row.candidateId}`, row]));
  const rows = db.prepare(`
    SELECT agentId, candidateId, kind, day, application, destination, bytesOut, usualBytesOut,
           answer, answeredAt, note
    FROM agent_outbound_candidates
    ORDER BY day DESC, agentId, candidateId
  `).all();
  const byAgent = new Map(reports.map(report => [report.agentId, {
    ...report,
    notesShared: report.notesShared === null ? null : report.notesShared === 1,
    entries: [],
  }]));
  for (const row of rows) {
    const agent = byAgent.get(row.agentId);
    if (!agent) continue;
    const fromHub = hub.get(`${row.agentId}\n${row.candidateId}`);
    const hubIsNewer = fromHub && (row.answeredAt === null || fromHub.answeredAt > row.answeredAt);
    agent.entries.push({
      candidateId: row.candidateId,
      kind: row.kind,
      day: row.day,
      application: row.application,
      destination: row.destination,
      bytesOut: row.bytesOut,
      usualBytesOut: row.usualBytesOut,
      answer: hubIsNewer ? fromHub.answer : row.answer,
      answeredAt: hubIsNewer ? fromHub.answeredAt : row.answeredAt,
      note: hubIsNewer ? (agent.notesShared ? fromHub.note : row.note) : row.note,
      answeredOn: hubIsNewer ? 'hub' : (row.answeredAt === null ? null : 'agent'),
    });
  }
  return [...byAgent.values()];
}

const hubAnswerBodySchema = z.object({
  answer: z.enum(['expected', 'investigate']).nullable(),
  note: z.string().max(NOTE_LIMIT).nullable().optional(),
}).strict();

/** The number an Agent compares to know whether to ask for answers. */
function answersVersion(db, agentId) {
  return db.prepare('SELECT version FROM agent_outbound_candidate_answer_versions WHERE agentId = ?')
    .get(agentId)?.version ?? 0;
}

/**
 * An administrator's answer to one of an Agent's candidates. `answer: null`
 * takes the answer back. A note is kept only when the Agent shares notes;
 * otherwise it would reach the Agent without the person having agreed to
 * notes going either way.
 */
function setHubAnswer(db, { agentId, candidateId, answer, note, answeredBy, now = Date.now() }) {
  const listed = db.prepare(`
    SELECT 1 FROM agent_outbound_candidates WHERE agentId = ? AND candidateId = ?
  `).get(agentId, candidateId);
  if (!listed) return { ok: false, reason: 'not_found' };
  const notesShared = db.prepare(
    'SELECT notesShared FROM agent_outbound_candidate_reports WHERE agentId = ?'
  ).get(agentId)?.notesShared === 1;
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed && !notesShared) return { ok: false, reason: 'notes_not_shared' };
  let version = 0;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO agent_outbound_candidate_hub_answers (agentId, candidateId, answer, note, answeredAt, answeredBy)
      VALUES (@agentId, @candidateId, @answer, @note, @answeredAt, @answeredBy)
      ON CONFLICT (agentId, candidateId) DO UPDATE SET
        answer = excluded.answer, note = excluded.note,
        answeredAt = excluded.answeredAt, answeredBy = excluded.answeredBy
    `).run({
      agentId,
      candidateId,
      answer,
      note: answer && notesShared && trimmed ? trimmed : null,
      answeredAt: now,
      answeredBy: answeredBy ?? null,
    });
    db.prepare(`
      INSERT INTO agent_outbound_candidate_answer_versions (agentId, version) VALUES (?, 1)
      ON CONFLICT (agentId) DO UPDATE SET version = version + 1
    `).run(agentId);
    version = answersVersion(db, agentId);
  })();
  return { ok: true, version, answeredAt: now };
}

/** What the Hub answered for this Agent, for the Agent to take in. */
function listHubAnswers(db, agentId) {
  const notesShared = db.prepare(
    'SELECT notesShared FROM agent_outbound_candidate_reports WHERE agentId = ?'
  ).get(agentId)?.notesShared === 1;
  const answers = db.prepare(`
    SELECT candidateId, answer, note, answeredAt FROM agent_outbound_candidate_hub_answers
    WHERE agentId = ? ORDER BY candidateId
  `).all(agentId).map(row => ({
    candidateId: row.candidateId,
    answer: row.answer,
    note: notesShared ? row.note : null,
    answeredAt: new Date(row.answeredAt).toISOString(),
  }));
  return { version: answersVersion(db, agentId), answers };
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
  db.prepare('DELETE FROM agent_outbound_candidate_hub_answers WHERE answeredAt < ?').run(cutoff);
  return removed;
}

module.exports = {
  MAX_ENTRIES,
  NOTE_LIMIT,
  RETENTION_MS,
  outboundCandidatesSchema,
  hubAnswerBodySchema,
  ensureOutboundCandidatesTables,
  answersVersion,
  setHubAnswer,
  listHubAnswers,
  replaceOutboundCandidates,
  listOutboundCandidates,
  pruneOutboundCandidates,
};
