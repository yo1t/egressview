'use strict';

const { createHash, randomUUID } = require('node:crypto');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createAiBudget({ history, now = () => Date.now(), limits = {} } = {}) {
  const configured = Object.freeze({
    principalRequests: positiveInteger(limits.principalRequests ?? process.env.EGRESSVIEW_AI_DAILY_REQUEST_LIMIT, 50),
    principalTokens: positiveInteger(limits.principalTokens ?? process.env.EGRESSVIEW_AI_DAILY_TOKEN_LIMIT, 1_000_000),
    providerRequests: positiveInteger(limits.providerRequests ?? process.env.EGRESSVIEW_AI_PROVIDER_DAILY_REQUEST_LIMIT, 200),
    providerTokens: positiveInteger(limits.providerTokens ?? process.env.EGRESSVIEW_AI_PROVIDER_DAILY_TOKEN_LIMIT, 4_000_000),
  });

  function principalHash(principal) {
    return createHash('sha256').update(`ai-budget:${String(principal || 'unknown')}`).digest('hex');
  }

  function begin({ principal, provider, kind }) {
    if (typeof history?.reserveAiBudget !== 'function') {
      const error = new Error('AI budget store is unavailable');
      error.code = 'AI_BUDGET_UNAVAILABLE';
      throw error;
    }
    const createdAt = now();
    const day = new Date(createdAt);
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    const eventId = randomUUID();
    const result = history.reserveAiBudget({
      eventId,
      principalHash: principalHash(principal),
      provider,
      kind,
      createdAt,
      dayStart,
      principalRequestLimit: configured.principalRequests,
      principalTokenLimit: configured.principalTokens,
      providerRequestLimit: configured.providerRequests,
      providerTokenLimit: configured.providerTokens,
    });
    if (!result.allowed) {
      const error = new Error('Daily AI usage limit reached');
      error.code = 'AI_BUDGET_EXCEEDED';
      error.reason = result.reason;
      throw error;
    }
    return Object.freeze({ eventId, provider, principalHash: principalHash(principal) });
  }

  function finish(reservation, { outcome, totalTokens = 0 } = {}) {
    if (!reservation?.eventId || typeof history?.completeAiBudget !== 'function') return false;
    return history.completeAiBudget(reservation.eventId, { outcome, totalTokens, completedAt: now() }) === 1;
  }

  return { begin, finish, limits: configured, principalHash };
}

module.exports = { createAiBudget };
