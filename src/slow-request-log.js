// P2-22: slow-request log — self-reports delays that only surface under
// production load (e.g. the gzip streaming issue) without manual profiling.
// The threshold is configurable via EGRESSVIEW_SLOW_REQUEST_MS (default 3000ms).
'use strict';

const logger = require('./logger');

/**
 * Creates an Express middleware that WARN-logs slow requests.
 * 'finish' fires once the response has been fully written to the OS, so
 * streaming-send delays (compression, large bodies) are included in the timing.
 *
 * @param {{ thresholdMs?: number, log?: (msg: string) => void }} [opts]
 */
function createSlowRequestLogger({
  thresholdMs = parseInt(process.env.EGRESSVIEW_SLOW_REQUEST_MS || '3000', 10),
  log = (msg) => logger.warn(msg),
} = {}) {
  return function slowRequestLogger(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (ms < thresholdMs) return;
      // Don't log the query string (avoids log bloat and guards against future params)
      const path = String(req.originalUrl || req.url || '').split('?')[0];
      const size = res.getHeader && res.getHeader('content-length') || '-';
      log(`[slow-request] ${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms size=${size}`);
    });
    next();
  };
}

module.exports = { createSlowRequestLogger };
