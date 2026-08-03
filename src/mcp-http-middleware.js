// HTTP middleware for the remote MCP endpoint.
//
// Extracted from mcp-server.js (P2-68). That file had grown to hold the tool
// definitions, the transport bootstrap, OAuth wiring, rate limiting, request
// deadlines and the audit trail at once, which made every one of those
// concerns harder to change in isolation.
//
// Nothing here changes behaviour: the ordering constraints documented at each
// call site are the reason these are separate factories rather than one
// middleware, and startHttp() still decides the order it mounts them in.
'use strict';

const crypto = require('node:crypto');
const mcpAudit = require('./mcp-audit');

// The private HTTP transport authenticates a single operator-held token, so
// the identity it produces carries the fixed service permission set rather
// than scopes negotiated per request.
const MCP_SERVICE_PERMISSIONS = Object.freeze(['network.read', 'notes.write']);

function createAuthMiddleware(token) {
  return (req, res, next) => {
    const provided = req.headers['x-admin-token']
      || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(provided || '');
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.mcpAuth = Object.freeze({
      subject: 'private-token',
      clientId: 'private-http',
      scopes: MCP_SERVICE_PERMISSIONS,
    });
    next();
  };
}

function createToolScopeMiddleware(scopeMapping, oauth) {
  return (req, res, next) => {
    if (req.method !== 'POST' || req.body?.method !== 'tools/call') return next();
    const authorization = scopeMapping.authorizeTool(
      req.body?.params?.name,
      req.mcpAuth?.scopes
    );
    if (!authorization.classified) return next();
    if (authorization.allowed) return next();

    const challenge = oauth.challenge(
      'insufficient_scope',
      authorization.requiredScopes.join(' ')
    );
    res.set('WWW-Authenticate', challenge);
    return res.status(403).json({ error: 'insufficient_scope' });
  };
}

// Correlate a request across the rate limiter, the OAuth boundary and the
// tool call. A caller-supplied id is accepted only in a safe shape.
function resolveTimeoutMs(value, fallback) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  // A zero or negative timeout would disable the deadline entirely, which is
  // the failure this exists to prevent. Node timers also overflow above a
  // signed 32-bit delay, so keep the operational setting deliberately bounded.
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 600_000
    ? parsed
    : fallback;
}

function requestIdFor(req) {
  const supplied = String(req.get?.('X-Request-Id') || '').trim();
  if (/^[A-Za-z0-9._-]{1,100}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

// req.mcpAuth is populated by the OAuth layer with a normalized, verified
// identity. Before authentication it is absent, and the hashes are then null
// by design rather than by accident.
function auditContext(req) {
  return {
    subject: req.mcpAuth?.subject || null,
    clientId: req.mcpAuth?.clientId || null,
    scopes: req.mcpAuth?.scopes || null,
    requestId: req.mcpRequestId,
    // Present even when authentication fails, which is exactly when subject
    // and clientId are null. Express resolves this from X-Forwarded-For only
    // for the proxies named in MCP_TRUST_PROXY; otherwise it is the socket
    // address, so a caller cannot spoof it by sending its own header.
    clientIp: req.ip || null,
  };
}

function createRequestContextMiddleware() {
  return (req, _res, next) => {
    req.mcpRequestId = requestIdFor(req);
    req.mcpStartedAt = Date.now();
    next();
  };
}

// Two passes are required, and the order is load-bearing.
//
// The first runs before the body is parsed and before authentication, so a
// flood of unauthenticated or malformed requests is rejected without spending
// JSON parsing or JWKS work on it. At that point there is no identity, so only
// the global window and the concurrency cap can apply.
//
// The second runs after authentication, once req.mcpAuth carries a verified
// subject and client id. Applying per-identity limits any earlier would have
// silently done nothing.
function createRateLimitMiddleware(limiter, { stage = 'pre-auth' } = {}) {
  return (req, res, next) => {
    const identified = stage === 'post-auth';
    const verdict = limiter.check(
      identified
        ? { subject: req.mcpAuth?.subject, clientId: req.mcpAuth?.clientId, skipGlobal: true }
        : {}
    );
    if (verdict.allowed) {
      // Only the pre-auth pass holds a concurrency slot; taking a second one
      // after authentication would double-count the same request.
      if (!identified) {
        const release = limiter.acquire();
        let done = false;
        const finish = () => { if (!done) { done = true; release(); } };
        res.on('finish', finish);
        res.on('close', finish);
      }
      return next();
    }
    mcpAudit.append({
      eventType: 'mcp_rate_limited',
      outcome: 'failure',
      reason: verdict.reason,
      mcpMethod: req.body?.method,
      httpStatus: 429,
      ...auditContext(req),
      durationMs: Date.now() - req.mcpStartedAt,
    });
    res.set('Retry-After', String(verdict.retryAfterSeconds));
    return res.status(429).json({ error: 'rate_limited' });
  };
}

// Classifies the outcome of an authenticated MCP request for the audit trail.
// Reason codes only — never provider text, which can echo token contents.
function createAuditMiddleware() {
  return (req, res, next) => {
    res.on('finish', () => {
      const toolName = req.body?.method === 'tools/call' ? req.body?.params?.name : null;
      // Tool handlers write immediately, without waiting for a long-lived
      // stream to finish. Keep this fallback for calls rejected beforehand.
      if (toolName && req.mcpToolAuditWritten) return;
      const mcpMethod = typeof req.body?.method === 'string' ? req.body.method : null;
      const status = res.statusCode;
      // A streamed response that blew its deadline still reports 200; the
      // deadline flag is the authoritative signal, not the status code.
      const outcome = req.mcpTimedOut || status >= 400 ? 'failure' : 'success';
      let reason = null;
      if (status === 401) reason = res.get('WWW-Authenticate')?.includes('invalid_token')
        ? 'invalid_token' : 'unauthorized';
      else if (status === 403) reason = 'insufficient_scope';
      else if (status === 429) return; // already audited by the limiter
      else if (req.mcpTimedOut) reason = 'request_timeout';
      else if (status === 400) reason = 'bad_request';
      else if (status === 404) reason = 'not_found';
      else if (status === 405) reason = 'method_not_allowed';
      else if (status === 413) reason = 'payload_too_large';
      else if (status >= 400 && status < 500) reason = 'client_error';
      else if (status >= 500) reason = 'server_error';
      mcpAudit.append({
        eventType: toolName ? 'mcp_tool_call' : 'mcp_request',
        outcome,
        reason,
        toolName,
        mcpMethod,
        httpStatus: status,
        ...auditContext(req),
        durationMs: Date.now() - req.mcpStartedAt,
      });
    });
    next();
  };
}

function initializeMcpAudit(authConfig) {
  mcpAudit.initDb(process.env.MCP_AUDIT_DB_PATH || undefined, {
    hashKey: authConfig.auditHashKey,
  });
  mcpAudit.assertWritable();
  mcpAudit.prune();
  // Keep enforcing retention for the lifetime of the process, not just at
  // startup; an unref'd timer will not delay shutdown.
  mcpAudit.startPruneSchedule();
  mcpAudit.setWriteFailureHandler((error, total) => {
    if (total === 1 || total % 100 === 0) {
      process.stderr.write(
        `[egressview-mcp] AUDIT WRITE FAILED (${total} total): ${error.message}\n`
      );
    }
  });
}

module.exports = {
  MCP_SERVICE_PERMISSIONS,
  createAuthMiddleware,
  createToolScopeMiddleware,
  createRequestContextMiddleware,
  createRateLimitMiddleware,
  createAuditMiddleware,
  initializeMcpAudit,
  resolveTimeoutMs,
  requestIdFor,
  auditContext,
};
