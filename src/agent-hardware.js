'use strict';

// Who made an Agent's computer and which model it is, as the Agent reads it
// from the computer itself (P3-199). The device list shows the maker where a
// router could not name one: a Mac on Wi-Fi sends from a random hardware
// address, which names no maker, and a virtual machine behind its host's NAT
// is never seen by a router at all.
//
// Sent only to a Hub whose capabilities name the fields (`agentFields`); an
// older Hub refuses an envelope with a field it does not know. Kept in a
// table created here rather than by a schema migration, for the reason
// agent-inbound-probes.js gives.

const HARDWARE_FIELDS = Object.freeze(['manufacturer', 'model']);

function ensureAgentHardwareTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_hardware (
      agentId      TEXT PRIMARY KEY,
      manufacturer TEXT,
      model        TEXT,
      updatedAt    INTEGER NOT NULL
    );
  `);
}

/** Keeps what this delivery said; a delivery that says nothing changes nothing. */
function recordAgentHardware(db, agentId, agent, at) {
  const manufacturer = agent?.manufacturer ?? null;
  const model = agent?.model ?? null;
  if (manufacturer == null && model == null) return;
  db.prepare(`
    INSERT INTO agent_hardware (agentId, manufacturer, model, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(agentId) DO UPDATE SET
      manufacturer = excluded.manufacturer, model = excluded.model, updatedAt = excluded.updatedAt
  `).run(agentId, manufacturer, model, at);
}

/** @returns {Map<string, { manufacturer: string|null, model: string|null }>} */
function listAgentHardware(db) {
  const rows = db.prepare('SELECT agentId, manufacturer, model FROM agent_hardware').all();
  return new Map(rows.map(row => [row.agentId, { manufacturer: row.manufacturer, model: row.model }]));
}

module.exports = { HARDWARE_FIELDS, ensureAgentHardwareTable, recordAgentHardware, listAgentHardware };
