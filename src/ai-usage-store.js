'use strict';

function createAiUsageStore({ getDb }) {
  function requireDb() {
    const db = getDb();
    if (!db) throw new Error('history database is not initialized');
    return db;
  }

  function appendAiUsage(row) {
    requireDb().prepare(`
      INSERT OR IGNORE INTO ai_usage
        (usageId, requestId, conversationId, kind, createdAt, provider, model,
         inputTokens, outputTokens, totalTokens, estimatedCostUsd,
         pricingVersion, inputUsdPerMillion, outputUsdPerMillion)
      VALUES
        (@usageId, @requestId, @conversationId, @kind, @createdAt, @provider, @model,
         @inputTokens, @outputTokens, @totalTokens, @estimatedCostUsd,
         @pricingVersion, @inputUsdPerMillion, @outputUsdPerMillion)
    `).run(row);
  }

  function summarizeAiUsage(from, to) {
    return requireDb().prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(inputTokens), 0) AS inputTokens,
             COALESCE(SUM(outputTokens), 0) AS outputTokens,
             COALESCE(SUM(totalTokens), 0) AS totalTokens,
             COALESCE(SUM(CASE WHEN estimatedCostUsd IS NOT NULL THEN 1 ELSE 0 END), 0) AS pricedRequests,
             COALESCE(SUM(CASE WHEN estimatedCostUsd IS NOT NULL THEN totalTokens ELSE 0 END), 0) AS pricedTokens,
             COALESCE(SUM(CASE WHEN totalTokens = 0 THEN 1 ELSE 0 END), 0) AS usageMissingRequests,
             COALESCE(SUM(CASE WHEN totalTokens > 0 AND estimatedCostUsd IS NULL THEN 1 ELSE 0 END), 0) AS unknownPriceRequests,
             COALESCE(SUM(CASE WHEN totalTokens > 0 AND estimatedCostUsd IS NULL THEN totalTokens ELSE 0 END), 0) AS unpricedTokens,
             COALESCE(SUM(estimatedCostUsd), 0) AS estimatedCostUsd
      FROM ai_usage
      WHERE createdAt >= ? AND createdAt < ?
    `).get(from, to);
  }

  function summarizeUnpricedAiUsage(from, to, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    return requireDb().prepare(`
      SELECT provider,
             model,
             COUNT(*) AS requests,
             COALESCE(SUM(inputTokens), 0) AS inputTokens,
             COALESCE(SUM(outputTokens), 0) AS outputTokens,
             COALESCE(SUM(totalTokens), 0) AS totalTokens,
             MAX(createdAt) AS lastUsedAt
      FROM ai_usage
      WHERE createdAt >= ? AND createdAt < ?
        AND totalTokens > 0
        AND estimatedCostUsd IS NULL
      GROUP BY provider, model
      ORDER BY totalTokens DESC, provider, model
      LIMIT ?
    `).all(from, to, safeLimit);
  }

  function reserveAiBudget({
    eventId, principalHash, provider, kind, createdAt, dayStart,
    principalRequestLimit, principalTokenLimit, providerRequestLimit, providerTokenLimit,
  }) {
    const db = requireDb();
    return db.transaction(() => {
      const summarize = principal => db.prepare(`
        SELECT COUNT(*) AS requests, COALESCE(SUM(totalTokens), 0) AS totalTokens
        FROM ai_budget_events
        WHERE createdAt >= ? AND provider = ?
          AND (? IS NULL OR principalHash = ?)
      `).get(dayStart, provider, principal, principal);
      const principalUsage = summarize(principalHash);
      const providerUsage = summarize(null);
      let reason = null;
      if (principalUsage.requests >= principalRequestLimit) reason = 'principal_request_limit';
      else if (principalUsage.totalTokens >= principalTokenLimit) reason = 'principal_token_limit';
      else if (providerUsage.requests >= providerRequestLimit) reason = 'provider_request_limit';
      else if (providerUsage.totalTokens >= providerTokenLimit) reason = 'provider_token_limit';
      if (reason) return { allowed: false, reason, principalUsage, providerUsage };
      db.prepare(`
        INSERT INTO ai_budget_events
          (eventId, principalHash, provider, kind, createdAt, completedAt, totalTokens, outcome)
        VALUES (?, ?, ?, ?, ?, NULL, 0, 'reserved')
      `).run(eventId, principalHash, provider, kind, createdAt);
      return { allowed: true, principalUsage, providerUsage };
    })();
  }

  function completeAiBudget(eventId, { outcome, totalTokens = 0, completedAt = Date.now() }) {
    if (!['complete', 'failure'].includes(outcome)) throw new Error('invalid AI budget outcome');
    return requireDb().prepare(`
      UPDATE ai_budget_events
      SET outcome = ?, totalTokens = ?, completedAt = ?
      WHERE eventId = ? AND outcome = 'reserved'
    `).run(outcome, Math.max(0, Math.floor(Number(totalTokens) || 0)), completedAt, eventId).changes;
  }

  function summarizeAiBudget(principalHash, provider, from, to) {
    return requireDb().prepare(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(totalTokens), 0) AS totalTokens,
             COALESCE(SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END), 0) AS failures
      FROM ai_budget_events
      WHERE createdAt >= ? AND createdAt < ? AND provider = ?
        AND (? IS NULL OR principalHash = ?)
    `).get(from, to, provider, principalHash, principalHash);
  }

  return {
    appendAiUsage,
    summarizeAiUsage,
    summarizeUnpricedAiUsage,
    reserveAiBudget,
    completeAiBudget,
    summarizeAiBudget,
  };
}

module.exports = { createAiUsageStore };
