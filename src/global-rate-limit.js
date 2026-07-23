'use strict';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_READ_LIMIT = 600;
const DEFAULT_WRITE_LIMIT = 120;
const DEFAULT_MAX_BUCKETS = 20_000;

function boundedEnvInt(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function createGlobalRateLimit(options = {}) {
  const windowMs = options.windowMs ||
    boundedEnvInt('EGRESSVIEW_RATE_LIMIT_WINDOW_MS', DEFAULT_WINDOW_MS, 1000, 3600_000);
  const readLimit = options.readLimit ||
    boundedEnvInt('EGRESSVIEW_RATE_LIMIT_READS', DEFAULT_READ_LIMIT, 10, 100_000);
  const writeLimit = options.writeLimit ||
    boundedEnvInt('EGRESSVIEW_RATE_LIMIT_WRITES', DEFAULT_WRITE_LIMIT, 5, 10_000);
  const maxBuckets = options.maxBuckets || DEFAULT_MAX_BUCKETS;
  const buckets = new Map();
  function pruneExpired(now = Date.now()) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
  const timer = setInterval(pruneExpired, Math.max(windowMs, 60_000));
  timer.unref();

  return function globalRateLimit(req, res, next) {
    if (!req.path.startsWith('/api')) return next();
    const now = Date.now();
    const kind = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write';
    const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${kind}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxBuckets) {
        pruneExpired(now);
        if (buckets.size >= maxBuckets) {
          res.setHeader('Retry-After', Math.max(1, Math.ceil(windowMs / 1000)));
          return res.status(429).json({ error: 'Too many request sources' });
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const limit = kind === 'read' ? readLimit : writeLimit;
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - bucket.count));
    res.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));
    if (bucket.count > limit) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

module.exports = { createGlobalRateLimit };
