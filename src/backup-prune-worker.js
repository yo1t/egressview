'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const inventory = require('./backup-inventory');

function report(progress) {
  parentPort.postMessage({ type: 'progress', progress });
}

try {
  const options = { ...workerData.options, onProgress: report };
  const result = workerData.operation === 'execute'
    ? inventory.executePrune(options)
    : inventory.buildPrunePlan(options);
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
