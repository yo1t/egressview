// routerId generation and migration rules (P2-30 PR 1 spec).
//
// A routerId is an immutable machine identifier used across config, DB,
// API, WebSocket payloads, and logs. It is never shown as a display name
// and never regenerated when the display name, management IP, or
// credentials change. Deleted IDs are kept as tombstones and never reused.
'use strict';

const crypto = require('crypto');

// Format: lowercase letter first, then lowercase letters / digits / hyphens,
// 3-32 chars total.
const ROUTER_ID_RE = /^[a-z][a-z0-9-]{2,31}$/;

// Deterministic IDs assigned when migrating the legacy single-router config
// sections. Fixed values (no randomness) so the config migration and the DB
// migration produce the same ID even when they run independently.
const MIGRATED_IDS = Object.freeze({
  yamaha: 'yamaha1',
  cisco:  'cisco1',
});

const LEGACY_PREFIX = 'legacy-';

const SUPPORTED_KINDS = Object.freeze(['yamaha', 'cisco']);

function isValidRouterId(id) {
  return typeof id === 'string' && ROUTER_ID_RE.test(id);
}

/**
 * IDs reserved for migration and legacy placeholders — excluded from new
 * auto-generation and from manual assignment.
 */
function isReservedRouterId(id) {
  return id === MIGRATED_IDS.yamaha
    || id === MIGRATED_IDS.cisco
    || String(id || '').startsWith(LEGACY_PREFIX);
}

/**
 * The deterministic routerId for a legacy single-router config section.
 * @param {'yamaha'|'cisco'} kind
 */
function migratedRouterId(kind) {
  const id = MIGRATED_IDS[kind];
  if (!id) throw new Error(`unknown router kind: ${kind}`);
  return id;
}

/**
 * Sanitize an arbitrary source value into the routerId character set:
 * lowercase, disallowed chars replaced with '-', truncated to fit.
 */
function _sanitize(value) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return cleaned || 'unknown';
}

/**
 * Placeholder routerId for observation records whose originating router
 * config no longer exists. Never guesses a live router.
 * @param {string} source  legacy connections.source value ('yamaha', 'cisco', or unknown)
 */
function legacyPlaceholderId(source) {
  const body = _sanitize(source);
  return (LEGACY_PREFIX + body).slice(0, 32);
}

/**
 * Generate a new routerId: `<kind>-<8 hex chars>` (e.g. "cisco-3f9a2c1b").
 * Collision-checked against every ID the caller knows about — active
 * routers AND tombstones of deleted ones — because historical observation
 * rows keep referencing deleted IDs forever.
 *
 * @param {'yamaha'|'cisco'} kind
 * @param {Iterable<string>} [existingIds]  active + tombstoned routerIds
 */
function generateRouterId(kind, existingIds = []) {
  if (!SUPPORTED_KINDS.includes(kind)) throw new Error(`unknown router kind: ${kind}`);
  const taken = new Set(existingIds);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = `${kind}-${crypto.randomBytes(4).toString('hex')}`;
    if (!taken.has(id) && !isReservedRouterId(id)) return id;
  }
  // 4 random bytes give ~4 billion combinations; reaching here means the
  // caller passed a pathological existingIds set.
  throw new Error('could not generate a unique routerId');
}

/**
 * The source→routerId mapping used by both the config migration and the DB
 * migration (single helper so they can never disagree). A legacy source maps
 * to its deterministic migrated id when the config section still exists, and
 * to a legacy placeholder when it was deleted.
 */
function sourceRouterIdMap({ hasYamahaConfig = false, hasCiscoConfig = false } = {}) {
  return {
    yamaha: hasYamahaConfig ? MIGRATED_IDS.yamaha : legacyPlaceholderId('yamaha'),
    cisco:  hasCiscoConfig  ? MIGRATED_IDS.cisco  : legacyPlaceholderId('cisco'),
  };
}

/**
 * Expand a legacy connections.source value into the routerIds that observed
 * the connection. Deterministic rules only — never guesses a live router:
 *  - 'yamaha' / 'cisco'  → the mapped id (migrated or legacy placeholder)
 *  - 'yamaha+cisco'      → both mapped ids
 *  - 'inspect'           → the yamaha id (INSPECT syslog is a Yamaha RTX
 *                          feature, so those sessions were observed by the
 *                          configured Yamaha router)
 *  - anything else       → a legacy placeholder preserving the source value
 */
function expandSourceToRouterIds(source, map) {
  const s = String(source || '');
  if (s === 'yamaha')       return [map.yamaha];
  if (s === 'cisco')        return [map.cisco];
  if (s === 'yamaha+cisco') return [map.yamaha, map.cisco];
  if (s === 'inspect')      return [map.yamaha];
  return [legacyPlaceholderId(s)];
}

/** The adapter kind a routerId belongs to, for routers-table rows. */
function routerKindForId(id, map) {
  if (id === map.yamaha || id === legacyPlaceholderId('yamaha')) return 'yamaha';
  if (id === map.cisco  || id === legacyPlaceholderId('cisco'))  return 'cisco';
  return 'unknown';
}

module.exports = {
  ROUTER_ID_RE,
  MIGRATED_IDS,
  LEGACY_PREFIX,
  SUPPORTED_KINDS,
  isValidRouterId,
  isReservedRouterId,
  migratedRouterId,
  legacyPlaceholderId,
  generateRouterId,
  sourceRouterIdMap,
  expandSourceToRouterIds,
  routerKindForId,
};
