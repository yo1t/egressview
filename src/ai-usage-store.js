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
             COALESCE(SUM(CASE WHEN totalTokens = 0 THEN 1 ELSE 0 END), 0) AS usageMissingRequests,
             COALESCE(SUM(CASE WHEN totalTokens > 0 AND estimatedCostUsd IS NULL THEN 1 ELSE 0 END), 0) AS unknownPriceRequests,
             COALESCE(SUM(estimatedCostUsd), 0) AS estimatedCostUsd
      FROM ai_usage
      WHERE createdAt >= ? AND createdAt < ?
    `).get(from, to);
  }

  return { appendAiUsage, summarizeAiUsage };
}

module.exports = { createAiUsageStore };
