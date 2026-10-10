'use strict';

// Parses the threat feeds off the thread that answers requests (P3-184).
//
// URLhaus's recent list is a 7.7 MB CSV of about 33,000 lines. Parsed on the
// main thread, the hourly refresh stopped the Hub for 0.6-1.1 s every hour
// (measured 2026-10-10: `threatIntel.apply` 643 ms, of which the cache write
// was 23 ms). The parsers are the ones in threat-intel.js, unchanged; this
// only runs them here and hands back the entries.
const { parentPort, workerData } = require('node:worker_threads');
const threatIntel = require('./threat-intel');

const parsers = {
  feodo: threatIntel.parseFeodoTracker,
  threatfox: threatIntel.parseThreatFox,
  urlhaus: threatIntel.parseUrlhaus,
  spamhaus: threatIntel.parseSpamhausDrop,
};

const parsed = {};
for (const [name, text] of Object.entries(workerData || {})) {
  if (typeof text === 'string' && parsers[name]) parsed[name] = parsers[name](text);
}
parentPort.postMessage(parsed);
