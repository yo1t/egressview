'use strict';

const { Router } = require('express');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { z } = require('zod');

// One histogram for the process. It costs nothing while idle and is the only
// way to tell "the Hub is busy" apart from "the Hub is stuck".
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
eventLoopDelay.unref?.();
const {
  agentMetadataSchema,
  agentIngestEnvelopeSchema,
  validateAgentObservationWindow,
} = require('../agent-ingest-schema');
const { parseRequest } = require('../http-validation');
const { isLoopbackAddress } = require('../deployment-profile');
const { describeAgentTransport, shouldRefusePlaintext } = require('../agent-transport-warning');
const logger = require('../logger');

const enrollmentRequestSchema = z.object({
  // Case-insensitive: the operator retypes this once and must not be punished
  // for using lower case.
  code: z.string().trim().length(6).regex(/^[0-9A-Za-z]{6}$/),
  agent: agentMetadataSchema,
}).strict();
const claimSchema = z.object({
  requestId: z.string().uuid(),
  claimSecret: z.string().regex(/^egvc_[0-9a-f]{64}$/),
}).strict();
const approveSchema = z.object({ replaceExisting: z.boolean().optional() }).strict();
const transportConsentSchema = z.object({ allowPlaintext: z.boolean() }).strict();
const requestIdSchema = z.object({ requestId: z.string().uuid() }).strict();
const agentIdSchema = z.object({ agentId: z.string().uuid() }).strict();
const MAX_FAILURE_BUCKETS = 2048;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const INGEST_WINDOW_MS = 60 * 1000;

// Both were fixed values until 2026-08-12, which meant an operator whose agents
// send more often than expected had no way to accommodate them short of editing
// the source. The defaults are unchanged; only the ability to move them is new.
function boundedEnvInt(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const INGEST_REQUESTS_PER_WINDOW =
  boundedEnvInt('EGRESSVIEW_AGENT_INGEST_REQUESTS_PER_MINUTE', 30, 1, 10_000);
const INGEST_MAX_CONCURRENCY =
  boundedEnvInt('EGRESSVIEW_AGENT_INGEST_CONCURRENCY', 4, 1, 64);
const MAX_INGEST_BUCKETS = 4096;

/**
 * Plaintext is refused unless the operator has accepted it, or the traffic
 * never leaves the machine.
 *
 * Loopback is exempt because nothing reaches a network interface. Everything
 * else needs the opt-in, which exists so a home operator can run an agent over
 * a LAN without setting up TLS -- having been shown, in the settings UI, what
 * that exposes.
 */
function agentTransportRefused(req, allowPlaintext) {
  return shouldRefusePlaintext({
    httpsEnabled: req.secure === true,
    allowPlaintext: allowPlaintext === true,
    isLoopback: isLoopbackAddress(req.socket?.localAddress || ''),
  });
}

module.exports = function agentRoutes({
  requireAdmin,
  requireAgent,
  agentIdentities,
  agentIngest = null,
  authAudit,
  // Read at request time rather than captured: the operator can change consent
  // without restarting, and a stale copy would keep refusing (or keep allowing)
  // after the setting moved.
  isPlaintextAllowed = () => false,
  setPlaintextAllowed = () => {},
  // Injected so the route does not reach into the runtime directly; absent in
  // the unit tests, which exercise storage rather than the collection pipeline.
  recordConnections = null,
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

  /**
   * Feeds an accepted batch into the same collection pipeline a router poll
   * uses, so the flows are enriched, matched against the threat feeds, and
   * counted as device activity. The process name travels with them: it is the
   * one thing a router can never supply.
   */
  function recordAgentFlows(envelope) {
    if (typeof recordConnections !== 'function') return;
    const hostName = envelope.agent?.hostName || null;
    const sessions = envelope.observations.map(observation => ({
      src: observation.localAddress,
      sport: observation.localPort,
      dst: observation.remoteAddress,
      dport: observation.remotePort,
      proto: observation.networkProtocol,
      // The agent saw the flow start, so it knows a first-seen time that is
      // earlier and more accurate than the moment this request arrived.
      firstSeenHint: Date.parse(observation.firstObservedAt),
      agentHost: hostName,
      process: observation.processName || null,
      pid: Number.isInteger(observation.processID) ? observation.processID : null,
    }));
    try {
      recordConnections(sessions, Date.now(), 'agent');
    } catch (error) {
      // A batch that was stored must still be acknowledged. Losing the
      // enrichment for it is worse than losing the batch would be, so it is
      // logged rather than swallowed.
      logger.error('[agents] Recording agent flows failed:', error.message);
    }
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
    if (!agentTransportRefused(req, isPlaintextAllowed())) return next();
    audit(req, 'agent_transport_rejected', 'failure', { reason: 'plaintext_not_accepted' });
    return res.status(400).json({
      error: 'Unencrypted agent traffic is not accepted. Enable HTTPS, or accept the risk in settings.',
    });
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

  // Step 2 of three: a valid code produces a *request*, never an agent. The
  // metadata here is only what the client claims about itself, which is why an
  // administrator has to look at it before it becomes a credential.
  router.post('/agent/enrollment-requests', (req, res) => {
    const key = rateKey(req);
    const now = Date.now();
    const failure = currentFailure(key, now);
    if (failure?.count >= MAX_FAILURES) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((failure.expiresAt - now) / 1000)));
      audit(req, 'agent_enrollment_requested', 'failure', { reason: 'rate_limited' });
      return res.status(429).json({ error: 'Too many enrollment attempts' });
    }
    const parsed = parseRequest(enrollmentRequestSchema, req.body, res);
    if (!parsed.ok) {
      audit(req, 'agent_enrollment_requested', 'failure', { reason: 'invalid_request' });
      return;
    }

    let result;
    try {
      result = agentIdentities.requestEnrollment({
        code: parsed.data.code,
        metadata: parsed.data.agent,
        clientIpHash: req.clientIpHash || null,
      });
    } catch (error) {
      logger.error('[agents] Enrollment request failed:', error.message);
      audit(req, 'agent_enrollment_requested', 'failure', { reason: 'storage_error' });
      return res.status(500).json({ error: 'Enrollment request failed' });
    }

    if (!result.ok) {
      recordFailure(key, now);
      // Counted against the code itself so five wrong guesses burn it. The
      // rate limit alone cannot do this: it is per client, and a six character
      // code is short enough that a distributed guess would otherwise stay
      // within every individual limit.
      const attempt = agentIdentities.recordCodeAttempt(parsed.data.code);
      audit(req, 'agent_enrollment_requested', 'failure', {
        reason: result.reason,
        codeLocked: attempt.locked || undefined,
      });
      const status = result.reason === 'too_many_pending' ? 429 : 401;
      return res.status(status).json({ error: 'Invalid or expired enrollment code' });
    }

    failedEnrollments.delete(key);
    audit(req, 'agent_enrollment_requested', 'success', {
      requestRef: agentIdentities.auditRef(result.requestId),
      platform: parsed.data.agent.platform,
    });
    return res.status(202).json({
      requestId: result.requestId,
      claimSecret: result.claimSecret,
      expiresAt: result.expiresAt,
      status: 'pending',
    });
  });

  // Step 3: the agent polls until an administrator decides. The token is
  // handed over exactly once and only to the holder of the claim secret.
  router.post('/agent/enrollment-requests/claim', (req, res) => {
    const parsed = parseRequest(claimSchema, req.body, res);
    if (!parsed.ok) return;
    const outcome = agentIdentities.claimApproved(parsed.data);
    if (outcome.status !== 'approved') {
      // Deliberately not distinguishing "unknown request" from "wrong secret":
      // both mean the caller cannot have this token.
      return res.status(outcome.status === 'unknown' ? 404 : 200).json({ status: outcome.status });
    }
    audit(req, 'agent_enrolled', 'success', { agentRef: agentIdentities.auditRef(outcome.agentId) });
    return res.status(201).json({ status: 'approved', token: outcome.token, agentId: outcome.agentId });
  });

  // Reports how agents reach this Hub and, when that is unencrypted, what the
  // operator is being asked to accept. Returned as keys rather than sentences
  // so both languages stay in the shared catalogue.
  router.get('/agents/transport', requireAdmin, (req, res) => {
    res.json(describeAgentTransport({
      httpsEnabled: req.secure === true,
      allowPlaintext: isPlaintextAllowed() === true,
    }));
  });

  router.post('/agents/transport', requireAdmin, (req, res) => {
    const parsed = parseRequest(transportConsentSchema, req.body, res);
    if (!parsed.ok) return;
    try {
      setPlaintextAllowed(parsed.data.allowPlaintext);
    } catch (error) {
      logger.error('[agents] Transport consent save failed:', error.message);
      audit(req, 'agent_transport_consent', 'failure');
      return res.status(500).json({ error: 'Could not save the setting' });
    }
    // Worth an audit line either way: turning it on widens what the Hub
    // accepts, and turning it off is a security action someone may need to
    // prove later.
    audit(req, 'agent_transport_consent', 'success', { allowPlaintext: parsed.data.allowPlaintext });
    return res.json(describeAgentTransport({
      httpsEnabled: req.secure === true,
      allowPlaintext: parsed.data.allowPlaintext,
    }));
  });

  router.get('/agents/enrollment-requests', requireAdmin, (_req, res) => {
    try {
      agentIdentities.expireStaleRequests();
      res.json({ requests: agentIdentities.listPendingRequests() });
    } catch (error) {
      logger.error('[agents] Pending request listing failed:', error.message);
      res.status(500).json({ error: 'Pending enrollment listing failed' });
    }
  });

  router.post('/agents/enrollment-requests/:requestId/approve', requireAdmin, (req, res) => {
    const params = parseRequest(requestIdSchema, req.params, res);
    if (!params.ok) return;
    const body = parseRequest(approveSchema, req.body ?? {}, res);
    if (!body.ok) return;
    let approved;
    try {
      approved = agentIdentities.approveRequest(params.data.requestId, {
        decidedBy: req.principal,
        replaceExisting: body.data.replaceExisting === true,
      });
    } catch (error) {
      logger.error('[agents] Approval failed:', error.message);
      audit(req, 'agent_enrollment_approved', 'failure', { reason: 'storage_error' });
      return res.status(500).json({ error: 'Approval failed' });
    }
    if (!approved) {
      audit(req, 'agent_enrollment_approved', 'failure', { reason: 'not_pending' });
      return res.status(404).json({ error: 'No pending request with that id' });
    }
    audit(req, 'agent_enrollment_approved', 'success', {
      agentRef: agentIdentities.auditRef(approved.agentId),
      replacedExisting: body.data.replaceExisting === true || undefined,
    });
    // The token is not returned here. It goes to the agent, which proves it is
    // the same client that applied; putting it in this response would put a
    // live credential on the approver's screen for no reason.
    return res.status(200).json({ agent: approved.agent });
  });

  router.post('/agents/enrollment-requests/:requestId/reject', requireAdmin, (req, res) => {
    const params = parseRequest(requestIdSchema, req.params, res);
    if (!params.ok) return;
    const rejected = agentIdentities.rejectRequest(params.data.requestId, { decidedBy: req.principal });
    audit(req, 'agent_enrollment_rejected', rejected ? 'success' : 'failure');
    return res.status(rejected ? 200 : 404).json({ rejected });
  });

  router.get('/agents', requireAdmin, (_req, res) => {
    try {
      res.json({ agents: agentIdentities.listAgents() });
    } catch (error) {
      logger.error('[agents] Listing failed:', error.message);
      res.status(500).json({ error: 'Agent listing failed' });
    }
  });

  router.get('/agents/ingest-metrics', requireAdmin, (req, res) => {
    // Ingest writes to SQLite synchronously, on the loop that also answers the
    // web UI. Throughput therefore says nothing about whether the Hub is still
    // usable -- P2-87 was fast at storing and completely unusable at the same
    // time. This delay is the number that tells an operator how close ingest is
    // to taking the site down with it.
    const delay = {
      p50: Math.round(eventLoopDelay.percentile(50) / 1e6),
      p95: Math.round(eventLoopDelay.percentile(95) / 1e6),
      max: Math.round(eventLoopDelay.max / 1e6),
    };
    if (req.query.resetDelay === '1') eventLoopDelay.reset();
    res.json({
      ...ingestMetrics,
      inFlight: activeIngests,
      eventLoopDelayMs: delay,
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
        // Storing the observation is not enough. Threat matching, destination
        // enrichment, device tracking and notifications all run over
        // connections, so an agent flow that never became one was listed
        // without ever being checked against anything -- indistinguishable, on
        // screen, from a flow that was checked and found safe.
        recordAgentFlows(parsed.data);
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
