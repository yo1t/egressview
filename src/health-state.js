'use strict';

function createHealthState() {
  let ready = false;
  const degraded = new Map();

  return {
    markReady() {
      ready = true;
    },
    markNotReady() {
      ready = false;
    },
    markDegraded(component, reason = 'unavailable') {
      degraded.set(String(component), String(reason));
    },
    clearDegraded(component) {
      degraded.delete(String(component));
    },
    isReady() {
      return ready && degraded.size === 0;
    },
    liveness() {
      return { status: 'ok' };
    },
    readiness() {
      if (!ready) return { status: 'not_ready' };
      if (degraded.size > 0) {
        return {
          status: 'degraded',
          components: [...degraded.entries()].map(([component, reason]) => ({ component, reason })),
        };
      }
      return { status: 'ready' };
    },
  };
}

module.exports = { createHealthState };
