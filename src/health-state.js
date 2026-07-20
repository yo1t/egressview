'use strict';

function createHealthState() {
  let ready = false;

  return {
    markReady() {
      ready = true;
    },
    markNotReady() {
      ready = false;
    },
    isReady() {
      return ready;
    },
    liveness() {
      return { status: 'ok' };
    },
    readiness() {
      return { status: ready ? 'ready' : 'not_ready' };
    },
  };
}

module.exports = { createHealthState };
