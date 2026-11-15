'use strict';

// How much of a period each Agent's reports reached the Hub (P3-194).
//
// An Agent has no heartbeat: it sends when it has flows to report. Running,
// it always has some -- on the production Hub (2026-11-15, seven days, five
// Agents) the median spacing between deliveries was 5 s for a Mac and 15 s
// for Windows -- so a five-minute slot with no delivery means the Agent, its
// computer or the network between them was not working. Which one cannot be
// told from deliveries alone: a closed laptop and a stopped Agent look the
// same. The quiet-Agent detector (agent-silence-detector.js) tells them apart
// when a router saw the computer's own traffic; a gap that began at the
// moment such a detection names is marked as the Agent having stopped.
//
// Read from `agent_ingest_batches`, kept as long as the observations (seven
// days by default). Measured on the production Hub: 75 ms for the busiest
// Agent's week (about 120,000 deliveries).

const SLOT_MS = 5 * 60 * 1000;
// Gaps shorter than this are retries and restarts, not outages: the Agent
// tab already calls an Agent quiet after 15 minutes.
const GAP_MIN_MS = 15 * 60 * 1000;
const GAP_LIST_MAX = 5;

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// When each detected silence began (the Agent's last delivery before it), per
// Agent. Read from the detection log, which may be absent in tests.
function silenceStarts(db) {
  const starts = new Map();
  if (!hasTable(db, 'notification_log')) return starts;
  const rows = db.prepare(`
    SELECT json_extract(threatTag, '$.agentId') AS agentId,
      json_extract(threatTag, '$.lastDeliveredAt') AS lastDeliveredAt
    FROM notification_log
    WHERE type = 'agent_silent' AND json_valid(threatTag)
  `).all();
  for (const row of rows) {
    const at = Number(row.lastDeliveredAt);
    if (!row.agentId || !Number.isFinite(at)) continue;
    if (!starts.has(row.agentId)) starts.set(row.agentId, new Set());
    starts.get(row.agentId).add(at);
  }
  return starts;
}

/**
 * Per Agent, from `since` (or its enrollment, if later) to `now`: how many
 * five-minute slots had a delivery, and the gaps of 15 minutes or more,
 * longest first. A gap still going on at `now` is marked `ongoing`.
 *
 * @param {Array<{ agentId: string, createdAt: number }>} agents
 */
function listUptime(db, { agents, since, now = Date.now(), gapLimit = GAP_LIST_MAX }) {
  const slotCount = db.prepare(`
    SELECT COUNT(DISTINCT receivedAt / ${SLOT_MS}) AS slots, COUNT(*) AS deliveries,
      MIN(receivedAt) AS firstAt, MAX(receivedAt) AS lastAt
    FROM agent_ingest_batches WHERE agentId = ? AND receivedAt >= ? AND receivedAt <= ?
  `);
  const innerGaps = db.prepare(`
    SELECT prev AS startAt, receivedAt AS endAt FROM (
      SELECT receivedAt, LAG(receivedAt) OVER (ORDER BY receivedAt) AS prev
      FROM agent_ingest_batches WHERE agentId = ? AND receivedAt >= ? AND receivedAt <= ?
    ) WHERE prev IS NOT NULL AND receivedAt - prev >= ?
  `);
  const silences = silenceStarts(db);

  return agents.map(agent => {
    const from = Math.max(since, Number(agent.createdAt) || since);
    const counted = slotCount.get(agent.agentId, from, now);
    const totalSlots = Math.floor(now / SLOT_MS) - Math.floor(from / SLOT_MS) + 1;
    // A delivery in the slot `from` falls in counts even though the period
    // starts part way through it, so the count is capped at the total.
    const deliveredSlots = Math.min(counted.slots, totalSlots);
    const gaps = [];
    if (counted.deliveries === 0) {
      gaps.push({ startAt: from, endAt: now, ongoing: true, startsWithPeriod: true });
    } else {
      if (counted.firstAt - from >= GAP_MIN_MS) {
        gaps.push({ startAt: from, endAt: counted.firstAt, ongoing: false, startsWithPeriod: true });
      }
      for (const row of innerGaps.all(agent.agentId, from, now, GAP_MIN_MS)) {
        gaps.push({ startAt: row.startAt, endAt: row.endAt, ongoing: false, startsWithPeriod: false });
      }
      if (now - counted.lastAt >= GAP_MIN_MS) {
        gaps.push({ startAt: counted.lastAt, endAt: now, ongoing: true, startsWithPeriod: false });
      }
    }
    const detected = silences.get(agent.agentId) || new Set();
    const listed = gaps
      .map(gap => ({
        ...gap,
        minutes: Math.round((gap.endAt - gap.startAt) / 60000),
        // The detector names a silence by the delivery it followed; a gap that
        // begins at the period's start began earlier and is not matched.
        agentStopped: !gap.startsWithPeriod && detected.has(gap.startAt),
      }))
      .sort((a, b) => b.minutes - a.minutes);
    return {
      agentId: agent.agentId,
      from,
      totalSlots,
      deliveredSlots,
      gapCount: listed.length,
      gapMinutes: listed.reduce((sum, gap) => sum + gap.minutes, 0),
      gaps: listed.slice(0, gapLimit).map(({ startsWithPeriod: _ignored, ...gap }) => gap),
    };
  });
}

module.exports = { SLOT_MS, GAP_MIN_MS, GAP_LIST_MAX, listUptime };
