'use strict';

const { parentPort } = require('node:worker_threads');

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
parentPort.postMessage({ type: 'result', result: { candidates: [] } });
