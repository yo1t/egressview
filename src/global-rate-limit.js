'use strict';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_READ_LIMIT = 600;
const DEFAULT_WRITE_LIMIT = 120;
const DEFAULT_MAX_BUCKETS = 20_000;

// Agent ingest gets its own budget because the general write limit is sized for
// a person clicking, and agents are not people. An agent may send 30 batches a
// minute, so the shared 120 write budget runs out at four agents -- and agents
// arriving from one address is the normal case the moment anything sits behind
// NAT. 1500 covers fifty agents at their own per-agent ceiling.
//
// Raising it is safe because authentication now runs before the 512 KiB body is
// read: a caller without a credential is refused after the headers, so the cost
// of a rejected attempt no longer scales with the batch size.
const DEFAULT_AGENT_INGEST_LIMIT = 1500;
const AGENT_INGEST_PATH = '/api/agent/ingest';

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
  const agentIngestLimit = options.agentIngestLimit ||
    boundedEnvInt('EGRESSVIEW_AGENT_INGEST_WRITES_PER_IP', DEFAULT_AGENT_INGEST_LIMIT, 30, 100_000);
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
    const kind = req.path === AGENT_INGEST_PATH ? 'agent-ingest'
      : (['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write');
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
    const limit = kind === 'agent-ingest' ? agentIngestLimit
      : (kind === 'read' ? readLimit : writeLimit);
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
