'use strict';

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 10_000;

function resolvePollInterval(value, logger = console) {
  if (value == null || value === '') return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn(`[config] Invalid POLL_INTERVAL_MS; using ${DEFAULT_POLL_INTERVAL_MS}ms`);
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (parsed < MIN_POLL_INTERVAL_MS) {
    logger.warn(`[config] POLL_INTERVAL_MS=${parsed}ms is too aggressive; clamped to ${MIN_POLL_INTERVAL_MS}ms`);
    return MIN_POLL_INTERVAL_MS;
  }
  return parsed;
}

module.exports = {
  resolvePollInterval,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
};
