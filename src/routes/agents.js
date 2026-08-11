'use strict';

const { Router } = require('express');
const { z } = require('zod');
const {
  agentMetadataSchema,
  agentIngestEnvelopeSchema,
  validateAgentObservationWindow,
} = require('../agent-ingest-schema');
const { parseRequest } = require('../http-validation');
const { isLoopbackAddress } = require('../deployment-profile');
const logger = require('../logger');

const enrollSchema = z.object({
  code: z.string().regex(/^egve_[0-9a-f]{48}$/),
  agent: agentMetadataSchema,
}).strict();
const agentIdSchema = z.object({ agentId: z.string().uuid() }).strict();
const MAX_FAILURE_BUCKETS = 2048;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const INGEST_WINDOW_MS = 60 * 1000;
const INGEST_REQUESTS_PER_WINDOW = 30;
const INGEST_MAX_CONCURRENCY = 4;
const MAX_INGEST_BUCKETS = 4096;

function hasSecureAgentTransport(req) {
  return req.secure || isLoopbackAddress(req.socket?.localAddress || '');
}

module.exports = function agentRoutes({
  requireAdmin,
  requireAgent,
  agentIdentities,
  agentIngest = null,
  authAudit,
}) {
  const router = Router();
  const failedEnrollments = new Map();
  const ingestWindows = new Map();
  let activeIngests = 0;
  const ingestMetrics = {
    requests: 0,
    accepted: 0,
    duplicate: 0,
    rejected: 0,
    failures: 0,
    rateLimited: 0,
    maxInFlight: 0,
    lastDurationMs: 0,
  };

  router.use(['/agents', '/agent'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  function audit(req, eventType, outcome, metadata) {
    authAudit.append({
      eventType,
      outcome,
      authMethod: req.authMethod || 'enrollment-code',
      actor: req.actor,
      principal: req.principal,
      requestId: req.id,
      clientIp: req.ip,
      httpMethod: req.method,
      path: req.originalUrl,
      metadata,
    });
  }

  function rateKey(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  function currentFailure(key, now) {
    const failure = failedEnrollments.get(key);
    if (!failure || failure.expiresAt <= now) {
      failedEnrollments.delete(key);
      return null;
    }
    return failure;
  }

  function recordFailure(key, now) {
    if (failedEnrollments.size >= MAX_FAILURE_BUCKETS && !failedEnrollments.has(key)) {
      for (const [candidate, failure] of failedEnrollments) {
        if (failure.expiresAt <= now) failedEnrollments.delete(candidate);
      }
      if (failedEnrollments.size >= MAX_FAILURE_BUCKETS) {
        failedEnrollments.delete(failedEnrollments.keys().next().value);
      }
    }
    const count = (currentFailure(key, now)?.count || 0) + 1;
    const failure = { count, expiresAt: now + FAILURE_WINDOW_MS };
    failedEnrollments.set(key, failure);
    return failure;
  }

  function acquireAgentWindow(agentId, now) {
    let window = ingestWindows.get(agentId);
    if (!window || window.resetAt <= now) {
      if (ingestWindows.size >= MAX_INGEST_BUCKETS && !ingestWindows.has(agentId)) {
        for (const [candidate, value] of ingestWindows) {
          if (value.resetAt <= now) ingestWindows.delete(candidate);
        }
        if (ingestWindows.size >= MAX_INGEST_BUCKETS) {
          ingestWindows.delete(ingestWindows.keys().next().value);
        }
      }
      window = { count: 0, resetAt: now + INGEST_WINDOW_MS };
      ingestWindows.set(agentId, window);
    }
    if (window.count >= INGEST_REQUESTS_PER_WINDOW) return window;
    window.count += 1;
    return null;
  }

  router.use('/agent', (req, res, next) => {
    if (hasSecureAgentTransport(req)) return next();
    audit(req, 'agent_transport_rejected', 'failure', { reason: 'https_required' });
    return res.status(400).json({ error: 'Agent endpoints require HTTPS' });
  });

  router.post('/agents/enrollment-tokens', requireAdmin, (req, res) => {
    try {
      const created = agentIdentities.createEnrollment({ createdBy: req.principal });
      audit(req, 'agent_enrollment_created', 'success', {
        enrollmentRef: agentIdentities.auditRef(created.tokenId),
        expiresAt: created.expiresAt,
      });
      res.status(201).json({ code: created.code, expiresAt: created.expiresAt });
    } catch (error) {
      audit(req, 'agent_enrollment_created', 'failure');
      if (/^At most \d+ active enrollment codes/.test(error.message)) {
        return res.status(409).json({ error: error.message });
      }
      logger.error('[agents] Enrollment creation failed:', error.message);
      return res.status(500).json({ error: 'Enrollment code creation failed' });
    }
  });

  router.post('/agent/enroll', (req, res) => {
    const key = rateKey(req);
    const now = Date.now();
    const failure = currentFailure(key, now);
    if (failure?.count >= MAX_FAILURES) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((failure.expiresAt - now) / 1000)));
      audit(req, 'agent_enrolled', 'failure', { reason: 'rate_limited' });
      return res.status(429).json({ error: 'Too many enrollment attempts' });
    }
    const parsed = parseRequest(enrollSchema, req.body, res);
    if (!parsed.ok) {
      audit(req, 'agent_enrolled', 'failure', { reason: 'invalid_request' });
      return;
    }
    let enrolled;
    try {
      enrolled = agentIdentities.enroll({
        code: parsed.data.code,
        metadata: parsed.data.agent,
      });
    } catch (error) {
      logger.error('[agents] Enrollment failed:', error.message);
      audit(req, 'agent_enrolled', 'failure', { reason: 'storage_error' });
      return res.status(500).json({ error: 'Agent enrollment failed' });
    }
    if (!enrolled) {
      recordFailure(key, now);
      audit(req, 'agent_enrolled', 'failure', { reason: 'invalid_or_expired_code' });
      return res.status(401).json({ error: 'Invalid or expired enrollment code' });
    }
    failedEnrollments.delete(key);
    audit(req, 'agent_enrolled', 'success', {
      agentRef: agentIdentities.auditRef(enrolled.agent.agentId),
      platform: enrolled.agent.platform,
    });
    return res.status(201).json({ token: enrolled.token, agent: enrolled.agent });
  });

  router.get('/agents', requireAdmin, (_req, res) => {
    try {
      res.json({ agents: agentIdentities.listAgents() });
    } catch (error) {
      logger.error('[agents] Listing failed:', error.message);
      res.status(500).json({ error: 'Agent listing failed' });
    }
  });

  router.get('/agents/ingest-metrics', requireAdmin, (_req, res) => {
    res.json({
      ...ingestMetrics,
      inFlight: activeIngests,
      limits: {
        requestsPerMinutePerAgent: INGEST_REQUESTS_PER_WINDOW,
        maxConcurrent: INGEST_MAX_CONCURRENCY,
      },
    });
  });

  router.post('/agents/:agentId/revoke', requireAdmin, (req, res) => {
    const parsed = parseRequest(agentIdSchema, req.params, res);
    if (!parsed.ok) return;
    let revoked;
    try {
      revoked = agentIdentities.revokeAgent(parsed.data.agentId);
    } catch (error) {
      logger.error('[agents] Revocation failed:', error.message);
      audit(req, 'agent_revoked', 'failure', { reason: 'storage_error' });
      return res.status(500).json({ error: 'Agent revocation failed' });
    }
    audit(req, 'agent_revoked', revoked ? 'success' : 'failure', {
      agentRef: agentIdentities.auditRef(parsed.data.agentId),
    });
    if (!revoked) return res.status(404).json({ error: 'Agent not found or already revoked' });
    return res.json({ success: true });
  });

  router.post('/agent/token/rotate', requireAgent, (req, res) => {
    const currentToken = String(req.get('Authorization') || '').replace(/^Bearer /, '');
    let rotated;
    try {
      rotated = agentIdentities.rotateAgentToken(req.agentIdentity.agentId, currentToken);
    } catch (error) {
      logger.error('[agents] Token rotation failed:', error.message);
      audit(req, 'agent_token_rotated', 'failure', { reason: 'storage_error' });
      return res.status(500).json({ error: 'Agent credential rotation failed' });
    }
    audit(req, 'agent_token_rotated', rotated ? 'success' : 'failure', {
      agentRef: agentIdentities.auditRef(req.agentIdentity.agentId),
    });
    if (!rotated) return res.status(401).json({ error: 'Agent credential is not active' });
    return res.json(rotated);
  });

  router.post('/agent/ingest', requireAgent, async (req, res) => {
    const startedAt = Date.now();
    ingestMetrics.requests += 1;
    const limited = acquireAgentWindow(req.agentIdentity.agentId, startedAt);
    if (limited) {
      ingestMetrics.rateLimited += 1;
      res.setHeader('Retry-After', Math.max(1, Math.ceil((limited.resetAt - startedAt) / 1000)));
      audit(req, 'agent_ingest', 'failure', { reason: 'rate_limited' });
      return res.status(429).json({ error: 'Agent ingest rate limit exceeded' });
    }
    if (activeIngests >= INGEST_MAX_CONCURRENCY) {
      ingestMetrics.rateLimited += 1;
      res.setHeader('Retry-After', '1');
      audit(req, 'agent_ingest', 'failure', { reason: 'concurrency_limited' });
      return res.status(429).json({ error: 'Agent ingest is busy' });
    }

    const parsed = parseRequest(agentIngestEnvelopeSchema, req.body, res);
    if (!parsed.ok) {
      ingestMetrics.failures += 1;
      audit(req, 'agent_ingest', 'failure', { reason: 'invalid_request' });
      return;
    }
    const rejected = validateAgentObservationWindow(parsed.data, { now: startedAt });
    if (rejected.length > 0) {
      ingestMetrics.rejected += rejected.length;
      audit(req, 'agent_ingest', 'failure', {
        reason: 'invalid_observation_window',
        rejectedCount: rejected.length,
      });
      return res.status(422).json({
        error: 'Observation window validation failed',
        rejected,
        requestId: req.id,
      });
    }
    if (!agentIngest) {
      ingestMetrics.failures += 1;
      audit(req, 'agent_ingest', 'failure', { reason: 'storage_unavailable' });
      return res.status(503).json({ error: 'Agent ingest is unavailable' });
    }

    activeIngests += 1;
    ingestMetrics.maxInFlight = Math.max(ingestMetrics.maxInFlight, activeIngests);
    try {
      const ack = await Promise.resolve(agentIngest.storeBatch(
        req.agentIdentity.agentId,
        parsed.data,
        { receivedAt: startedAt }
      ));
      if (ack.replayed) {
        ingestMetrics.duplicate += parsed.data.observations.length;
      } else {
        ingestMetrics.accepted += ack.accepted;
        ingestMetrics.duplicate += ack.duplicate;
      }
      audit(req, 'agent_ingest', 'success', {
        batchRef: agentIdentities.auditRef(parsed.data.batchId),
        observationCount: parsed.data.observations.length,
        acceptedCount: ack.accepted,
        duplicateCount: ack.duplicate,
        replayed: ack.replayed,
        durationMs: Date.now() - startedAt,
      });
      return res.json({ ...ack, requestId: req.id });
    } catch (error) {
      ingestMetrics.failures += 1;
      logger.error('[agents] Ingest storage failed:', error.message);
      audit(req, 'agent_ingest', 'failure', { reason: 'storage_error' });
      return res.status(500).json({ error: 'Agent ingest failed', requestId: req.id });
    } finally {
      activeIngests -= 1;
      ingestMetrics.lastDurationMs = Date.now() - startedAt;
    }
  });

  return router;
};
