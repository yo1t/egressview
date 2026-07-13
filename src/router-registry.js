// Router registry (P2-30 PR 2): the single source of truth for which router
// instances exist in this process.
//
// Each entry pairs an immutable routerId with a contract-validated poller
// adapter. Deleted IDs become tombstones and can never be re-registered,
// because historical observation rows keep referencing them.
'use strict';

const { isValidRouterId } = require('./router-id');
const { validateRouterPoller } = require('./pollers/router-interface');

function createRouterRegistry({ tombstones: initialTombstones = [] } = {}) {
  const routers    = new Map(); // id → frozen entry
  const tombstones = new Set(initialTombstones); // deleted ids, never reusable

  return {
    /**
     * Register a router instance.
     * @param {{ id: string, adapter: object, displayName?: string }} spec
     * @returns the frozen registry entry
     */
    register({ id, adapter, displayName } = {}) {
      if (!isValidRouterId(id)) {
        throw new Error(`invalid routerId: ${JSON.stringify(id)}`);
      }
      if (routers.has(id)) {
        throw new Error(`routerId already registered: ${id}`);
      }
      if (tombstones.has(id)) {
        throw new Error(`routerId was deleted and cannot be reused: ${id}`);
      }
      validateRouterPoller(adapter);
      const entry = Object.freeze({
        id,
        kind: adapter.kind,
        displayName: displayName || id,
        adapter,
      });
      routers.set(id, entry);
      return entry;
    },

    /**
     * Remove a router, leaving a tombstone so the id is never reused.
     * @returns {boolean} true if the router existed
     */
    unregister(id) {
      if (!routers.delete(id)) return false;
      tombstones.add(id);
      return true;
    },

    replace({ id, adapter, displayName } = {}) {
      if (!routers.has(id)) throw new Error(`routerId is not registered: ${id}`);
      validateRouterPoller(adapter);
      const entry = Object.freeze({ id, kind: adapter.kind, displayName: displayName || id, adapter });
      routers.set(id, entry);
      return entry;
    },

    get(id)  { return routers.get(id) || null; },
    has(id)  { return routers.has(id); },
    list()   { return [...routers.values()]; },
    size()   { return routers.size; },

    /** Active ids plus tombstones — the collision set for generateRouterId(). */
    allKnownIds() { return new Set([...routers.keys(), ...tombstones]); },
    tombstones() { return [...tombstones]; },
  };
}

module.exports = { createRouterRegistry };
