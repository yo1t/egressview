/**
 * What the AI has cost this month and last.
 *
 * Split out of `ai-insights.js` (P2-97). Everything that spends budget asks
 * for this to be redrawn -- facts, chat, notifications -- so it is a leaf that
 * the others import rather than something that imports them.
 */

import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { formatNumber, formatUsd } from './ai-format.js?v=__ASSET_VERSION__';

function renderUsagePeriod(name, data) {
  document.getElementById(`ai-usage-${name}-tokens`).textContent = tVars('ai.usage.tokens', {
    tokens: formatNumber(data.totalTokens),
  });
  document.getElementById(`ai-usage-${name}-detail`).textContent = tVars('ai.usage.detail', {
    input: formatNumber(data.inputTokens),
    output: formatNumber(data.outputTokens),
  });
  const isPartial = Number(data.unpricedTokens) > 0;
  document.getElementById(`ai-usage-${name}-cost`).textContent = tVars(
    isPartial ? 'ai.usage.costPartial' : 'ai.usage.cost', {
    cost: formatUsd(data.estimatedCostUsd),
  });
  document.getElementById(`ai-usage-${name}-unpriced`).textContent = isPartial
    ? tVars('ai.usage.unpricedDetail', {
      tokens: formatNumber(data.unpricedTokens),
      requests: formatNumber(data.unknownPriceRequests),
    })
    : '';
  document.getElementById(`ai-usage-${name}-requests`).textContent = tVars('ai.usage.requests', {
    requests: formatNumber(data.requests),
  });
}

function renderAiUsage(data) {
  renderUsagePeriod('current', data.current);
  renderUsagePeriod('previous', data.previous);
  const periods = [data.current, data.previous];
  const messages = [];
  if (periods.some(period => Number(period.unknownPriceRequests) > 0)) messages.push(t('ai.usage.unpriced'));
  const unpricedModels = [...new Set(periods.flatMap(period => period.unpricedModels || [])
    .map(row => `${row.provider}/${row.model || t('ai.chat.unknownModel')}`))];
  if (unpricedModels.length) {
    const shown = unpricedModels.slice(0, 5);
    const remaining = unpricedModels.length - shown.length;
    messages.push(tVars('ai.usage.unpricedModels', {
      models: shown.join(', '),
      remaining: remaining ? ` +${remaining}` : '',
    }));
  }
  if (periods.some(period => Number(period.usageMissingRequests) > 0)) messages.push(t('ai.usage.missing'));
  if (data.pricing?.catalogVersion) {
    messages.push(tVars('ai.usage.catalog', {
      version: data.pricing.catalogVersion,
      effective: data.pricing.effectiveFrom || data.pricing.catalogVersion,
    }));
  }
  document.getElementById('ai-usage-caveat').textContent = messages.join(' ');
}

async function refreshAiUsage() {
  try {
    const params = new URLSearchParams({ timezoneOffset: String(new Date().getTimezoneOffset()) });
    const response = await apiFetch(`${_BASE}/api/ai/usage/monthly?${params}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.usage.error'));
    renderAiUsage(body);
    return true;
  } catch {
    document.getElementById('ai-usage-caveat').textContent = t('ai.usage.error');
    return false;
  }
}

export { renderAiUsage, refreshAiUsage };
