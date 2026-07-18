import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { getTimeRange } from './connections-panel.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { switchView } from './view-tabs.js?v=__ASSET_VERSION__';
import { setLogThreatFilter } from './log.js?v=__ASSET_VERSION__';

const REFRESH_MS = 15_000;
const METRICS = ['connections', 'devices', 'destinations', 'warn', 'danger'];
let refreshTimer = null;
let generation = 0;
let analysisController = null;

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function deltaSummary(current, previous) {
  const delta = current - previous;
  if (previous === 0) return { delta, percent: null };
  return { delta, percent: Math.round((delta / previous) * 100) };
}

function renderDelta(element, current, previous) {
  const { delta, percent } = deltaSummary(current, previous);
  element.classList.toggle('is-up', delta > 0);
  element.classList.toggle('is-down', delta < 0);
  const sign = delta > 0 ? '+' : '';
  const percentText = percent == null ? '—' : `${sign}${percent}%`;
  element.textContent = tVars('ai.delta', { delta: `${sign}${formatNumber(delta)}`, percent: percentText });
}

function renderCollection(collection) {
  const container = document.getElementById('ai-collection');
  container.className = `ai-collection is-${collection.health}`;
  document.getElementById('ai-collection-label').textContent = tVars(`ai.collection.${collection.health}`, {
    ready: collection.readyCount,
    total: collection.enabledCount,
  });
  const routerList = document.getElementById('ai-router-list');
  routerList.replaceChildren(...collection.routers.filter(router => router.enabled).map(router => {
    const item = document.createElement('span');
    item.className = `ai-router ${router.ready ? 'is-ready' : 'is-error'}`;
    item.textContent = `${router.displayName} · ${formatNumber(router.sessionCount)}`;
    return item;
  }));
  document.getElementById('ai-updated').textContent = collection.lastUpdatedAt
    ? tVars('ai.updated', { time: new Date(collection.lastUpdatedAt).toLocaleTimeString() })
    : t('ai.updated.none');
}

function renderFacts(data) {
  renderCollection(data.collection);
  for (const metric of METRICS) {
    const current = Number(data.current[metric]) || 0;
    const previous = Number(data.previous[metric]) || 0;
    document.getElementById(`ai-value-${metric}`).textContent = formatNumber(current);
    renderDelta(document.getElementById(`ai-delta-${metric}`), current, previous);
    if (metric === 'warn' || metric === 'danger') {
      document.querySelector(`[data-ai-metric="${metric}"]`).classList.toggle('has-findings', current > 0);
    }
  }
}

async function refreshAiInsights() {
  const requestGeneration = ++generation;
  const now = Date.now();
  const range = getTimeRange();
  const from = range.from ?? now - 3600_000;
  const to = range.to ?? now;
  const error = document.getElementById('ai-error');
  error.classList.remove('is-visible');
  try {
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    const response = await apiFetch(`${_BASE}/api/ai/facts?${params}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || t('ai.error'));
    }
    const data = await response.json();
    if (requestGeneration !== generation) return;
    renderFacts(data);
  } catch (cause) {
    if (requestGeneration !== generation) return;
    error.textContent = cause.message || t('ai.error');
    error.classList.add('is-visible');
  }
}

function setAnalysisRunning(running) {
  document.getElementById('ai-analyze-btn').disabled = running;
  document.getElementById('ai-cancel-btn').classList.toggle('is-hidden', !running);
}

async function analyzeCurrentRange() {
  if (analysisController) return;
  const now = Date.now();
  const range = getTimeRange();
  const from = range.from ?? now - 3600_000;
  const to = range.to ?? now;
  const result = document.getElementById('ai-analysis-result');
  const meta = document.getElementById('ai-analysis-meta');
  const error = document.getElementById('ai-error');
  analysisController = new AbortController();
  setAnalysisRunning(true);
  error.classList.remove('is-visible');
  result.textContent = t('ai.analysis.running');
  meta.textContent = '';
  try {
    const configResponse = await apiFetch(`${_BASE}/api/config/ai`, { signal: analysisController.signal });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok) throw new Error(config.error || t('ai.analysis.failed'));
    const cloud = config.provider === 'anthropic' || config.provider === 'openai';
    if (cloud && !globalThis.confirm(tVars('ai.analysis.cloudConfirm', { provider: config.provider }))) {
      result.textContent = t('ai.analysis.cancelled');
      return;
    }
    const response = await apiFetch(`${_BASE}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, cloudConsentConfirmed: cloud }),
      signal: analysisController.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.analysis.failed'));
    result.textContent = body.text;
    meta.textContent = tVars('ai.analysis.meta', {
      provider: body.provider,
      model: body.model,
      time: new Date(body.generatedAt).toLocaleString(),
    });
  } catch (cause) {
    if (cause.name === 'AbortError') result.textContent = t('ai.analysis.cancelled');
    else {
      result.textContent = t('ai.analysis.empty');
      error.textContent = cause.message || t('ai.analysis.failed');
      error.classList.add('is-visible');
    }
  } finally {
    analysisController = null;
    setAnalysisRunning(false);
  }
}

function startAiInsights() {
  refreshAiInsights();
  if (!refreshTimer) refreshTimer = setInterval(refreshAiInsights, REFRESH_MS);
}

function stopAiInsights() {
  generation++;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function initAiInsights() {
  document.getElementById('ai-refresh-btn').addEventListener('click', refreshAiInsights);
  document.getElementById('ai-analyze-btn').addEventListener('click', analyzeCurrentRange);
  document.getElementById('ai-cancel-btn').addEventListener('click', () => analysisController?.abort());
  document.querySelectorAll('[data-ai-metric]').forEach(card => {
    card.addEventListener('click', () => {
      const metric = card.dataset.aiMetric;
      setLogThreatFilter(metric === 'warn' || metric === 'danger' ? metric : null);
      switchView('log');
    });
  });
}

initAiInsights();

export { analyzeCurrentRange, deltaSummary, renderFacts, refreshAiInsights, setAnalysisRunning, startAiInsights, stopAiInsights };
