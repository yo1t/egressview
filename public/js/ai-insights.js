import { t, tVars, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { getTimeRange } from './connections-panel.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { switchView } from './view-tabs.js?v=__ASSET_VERSION__';
import { setLogThreatFilter } from './log.js?v=__ASSET_VERSION__';
import {
  appendDisplayScope,
  getDisplayScope,
  getDisplayScopeLabel,
  withDisplayScope,
} from './display-scope.js?v=__ASSET_VERSION__';
import {
  formatNumber,
  formatRange,
  formatUsd,
  randomUuid,
} from './ai-format.js?v=__ASSET_VERSION__';
import {
  CLOUD_CONSENT_PROVIDERS,
  PROVIDER_LABELS,
  updateProviderLabel,
} from './ai-providers.js?v=__ASSET_VERSION__';
import { refreshAiUsage } from './ai-usage.js?v=__ASSET_VERSION__';
import {
  closeNotificationConfirmation,
  confirmNotificationConfig,
  loadNotificationSettings,
  openNotificationSettings,
  runNotificationAction,
  saveNotificationConfig,
  updateNotificationFrequencyFields,
  updateNotificationRuleFields,
} from './ai-notification-settings.js?v=__ASSET_VERSION__';

// One card refresh runs two aggregates over the selected window and two more
// over the window before it, synchronously on the loop that also serves the
// device list and the connection log. Measured on one Hub 2026-09-19 against
// 473,806 connections: 68 ms for an hour, 328 ms for a day, 667 ms for a week,
// 885 ms for two. Refreshing a two-week view every two seconds would spend
// nearly half the loop on these five cards, so the pace follows the period --
// short ranges keep up with the traffic, long ones cannot and do not pretend to.
const LIVE_INTERVAL_BY_SPAN = [
  [3600_000,   2_000],   // up to an hour
  [86400_000,  5_000],   // up to a day
  [Infinity,  15_000],   // longer: the query is too expensive to go faster
];
// Runs even when nothing arrives: collection health changes on its own, and the
// period boundary keeps moving whether or not there is traffic.
const FALLBACK_REFRESH_MS = 15_000;
// Spend against the AI budget does not move with network traffic.
const USAGE_REFRESH_MS = 60_000;
const METRICS = ['connections', 'devices', 'destinations', 'warn', 'danger'];

let refreshTimer = null;
let liveTimer = null;
let lastRefreshAt = 0;
let lastUsageAt = 0;
let generation = 0;
let analysisController = null;
let activeConversationId = null;
let chatController = null;
// Text of the most recent "analyze current period" result, so the chat can
// reason about the same threats. Reset when a new analysis is run.
let lastAnalysis = null;

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

// An open-ended period has no "to", so its width is measured against a clock
// that has moved on since getTimeRange read it, and against a server-time
// offset besides. Without slack, "the last hour" comes out a few milliseconds
// over an hour and falls into the next bucket: measured in a browser, the
// one-hour view was pacing itself at five seconds and the one-day view at
// fifteen. A minute is far less than the gap between any two selectable
// periods, so it can only correct this drift.
const SPAN_SLACK_MS = 60_000;

// The endpoint refuses a window wider than this, and the two clocks involved
// disagree: getTimeRange measures from the server's, the caller from the
// browser's. "The last two weeks" therefore came out a few milliseconds over
// fourteen days and was rejected outright -- observed in a browser, where every
// refresh of the two-week view answered 400 and the five cards showed an error
// instead of numbers.
const MAX_FACTS_RANGE_MS = 14 * 24 * 60 * 60 * 1000;

/** The selected period, never wider than the API will accept. */
function selectedFactsRange(now = Date.now()) {
  const range = getTimeRange();
  const to = range.to ?? now;
  return { from: Math.max(range.from ?? now - 3600_000, to - MAX_FACTS_RANGE_MS), to };
}

/** How often the cards may be recomputed, given how much the period costs. */
function liveIntervalMs() {
  const { from, to } = getTimeRange();
  const span = (to ?? Date.now()) - (from ?? 0);
  for (const [limit, interval] of LIVE_INTERVAL_BY_SPAN) {
    if (span - SPAN_SLACK_MS <= limit) return interval;
  }
  return FALLBACK_REFRESH_MS;
}

/**
 * Recompute the cards because traffic arrived, no sooner than the period allows.
 * Called for every connections-update; it decides for itself whether to act, so
 * a quiet network costs nothing at all.
 */
function scheduleLiveRefresh() {
  if (liveTimer || !refreshTimer) return;   // refreshTimer is set only while the tab is open
  const wait = Math.max(0, liveIntervalMs() - (Date.now() - lastRefreshAt));
  liveTimer = setTimeout(() => {
    liveTimer = null;
    refreshAiInsights({ live: true });
  }, wait);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.live] true for a socket-driven pass. Those are
 *   frequent, so they leave AI spend alone unless it has been a while. An
 *   explicit refresh -- opening the tab, the refresh button, changing the
 *   period, finishing an analysis -- always fetches it, because that is exactly
 *   when someone is looking at what the analysis cost.
 */
async function refreshAiInsights({ live = false } = {}) {
  const requestGeneration = ++generation;
  const now = Date.now();
  lastRefreshAt = now;
  const { from, to } = selectedFactsRange(now);
  const period = document.getElementById('ai-period');
  if (period) period.textContent = formatRange(from, to);
  const error = document.getElementById('ai-error');
  error.classList.remove('is-visible');
  try {
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    appendDisplayScope(params);
    const response = await apiFetch(`${_BASE}/api/ai/facts?${params}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || t('ai.error'));
    }
    const data = await response.json();
    if (requestGeneration !== generation) return;
    renderFacts(data);
    if (!live || Date.now() - lastUsageAt >= USAGE_REFRESH_MS) {
      lastUsageAt = Date.now();
      await refreshAiUsage();
    }
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

function renderChatMessages(messages) {
  const container = document.getElementById('ai-chat-messages');
  container.replaceChildren(...messages.map(message => {
    const item = document.createElement('div');
    item.className = `ai-chat-message is-${message.role}${message.status === 'failed' ? ' is-failed' : ''}`;
    const body = document.createElement('div');
    body.className = 'ai-chat-message-body';
    body.textContent = message.status === 'failed' ? t('ai.chat.failed') : (message.body || '');
    const scope = message.sourceKind && message.sourceId
      ? { sourceKind: message.sourceKind, sourceId: message.sourceId }
      : null;
    const scopeMeta = tVars('ai.chat.scopeMeta', { source: getDisplayScopeLabel(scope) });
    if (message.role !== 'assistant') {
      const meta = document.createElement('div');
      meta.className = 'ai-chat-message-meta';
      meta.textContent = scopeMeta;
      item.replaceChildren(body, meta);
      return item;
    }
    const meta = document.createElement('div');
    meta.className = 'ai-chat-message-meta';
    const provider = PROVIDER_LABELS[message.provider] || message.provider || t('ai.chat.unknownProvider');
    const model = message.model || t('ai.chat.unknownModel');
    const identity = tVars('ai.chat.responseMeta', { provider, model });
    if (message.usageTotalTokens == null || (
      Number(message.usageTotalTokens) === 0
      && Number(message.usageInputTokens) === 0
      && Number(message.usageOutputTokens) === 0
    )) {
      meta.textContent = `${identity} · ${t('ai.chat.usageUnavailable')} · ${scopeMeta}`;
    } else {
      const usage = message.estimatedCostUsd == null
        ? tVars('ai.chat.usageUnpriced', { tokens: formatNumber(message.usageTotalTokens) })
        : tVars('ai.chat.usagePriced', {
          tokens: formatNumber(message.usageTotalTokens),
          cost: formatUsd(message.estimatedCostUsd),
        });
      meta.textContent = `${identity} · ${usage} · ${scopeMeta}`;
    }
    item.replaceChildren(body, meta);
    return item;
  }));
  container.scrollTop = container.scrollHeight;
}

// Optimistically append the submitted question plus a "thinking" placeholder so
// the user sees their input immediately and knows inference is in progress.
function renderPendingExchange(userText) {
  const container = document.getElementById('ai-chat-messages');
  const user = document.createElement('div');
  user.className = 'ai-chat-message is-user';
  const userBody = document.createElement('div');
  userBody.className = 'ai-chat-message-body';
  userBody.textContent = userText;
  const userMeta = document.createElement('div');
  userMeta.className = 'ai-chat-message-meta';
  userMeta.textContent = tVars('ai.chat.scopeMeta', { source: getDisplayScopeLabel(getDisplayScope()) });
  user.replaceChildren(userBody, userMeta);
  const pending = document.createElement('div');
  pending.className = 'ai-chat-message is-assistant is-pending';
  pending.textContent = t('ai.chat.thinking');
  container.append(user, pending);
  container.scrollTop = container.scrollHeight;
}

function markPendingExchangeFailed() {
  const container = document.getElementById('ai-chat-messages');
  const pending = [...container.children].reverse()
    .find(element => element.classList.contains('is-pending'));
  if (!pending) return;
  pending.classList.remove('is-pending');
  pending.classList.add('is-failed');
  pending.textContent = t('ai.chat.failed');
}

async function loadConversation(conversationId) {
  activeConversationId = conversationId || null;
  if (!activeConversationId) {
    renderChatMessages([]);
    return;
  }
  const response = await apiFetch(`${_BASE}/api/ai/conversations/${encodeURIComponent(activeConversationId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || t('ai.chat.loadFailed'));
  renderChatMessages(body.messages || []);
}

async function loadConversations() {
  const response = await apiFetch(`${_BASE}/api/ai/conversations`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || t('ai.chat.loadFailed'));
  const select = document.getElementById('ai-conversation-select');
  const options = (body.conversations || []).map(conversation => {
    const option = document.createElement('option');
    option.value = conversation.conversationId;
    option.textContent = `${new Date(conversation.createdAt).toLocaleString()} · ${conversation.messageCount}`;
    return option;
  });
  select.replaceChildren(...options);
  document.getElementById('ai-chat-storage').textContent = tVars('ai.chat.storage', {
    conversations: body.storage?.conversations || 0,
    messages: body.storage?.messages || 0,
    bytes: body.storage?.bodyBytes || 0,
  });
  const nextId = activeConversationId && options.some(option => option.value === activeConversationId)
    ? activeConversationId : options[0]?.value || null;
  if (nextId) select.value = nextId;
  await loadConversation(nextId);
}

async function sendChatMessage() {
  if (chatController) return;
  const input = document.getElementById('ai-chat-input');
  const message = input.value.trim();
  if (!message) return;
  const now = Date.now();
  const { from, to } = selectedFactsRange(now);
  chatController = new AbortController();
  const button = document.getElementById('ai-chat-send-btn');
  button.disabled = true;
  // Reflect the submitted question right away and show a "thinking" bubble; no
  // per-message confirmation popup (settings-level consent is the gate).
  input.value = '';
  renderPendingExchange(message);
  const error = document.getElementById('ai-error');
  error.classList.remove('is-visible');
  let persistedByServer = false;
  try {
    const response = await apiFetch(`${_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withDisplayScope({
        conversationId: activeConversationId || undefined,
        requestId: randomUuid(),
        message,
        from,
        to,
        cloudConsentConfirmed: true,
        language: currentLang,
        // Include the latest analysis for the same range so the AI can build on it.
        priorAnalysis: lastAnalysis && lastAnalysis.from === from && lastAnalysis.to === to
          ? lastAnalysis.text
          : undefined,
      })),
      signal: chatController.signal,
    });
    const body = await response.json().catch(() => ({}));
    // The server persists the user message before invoking the provider and
    // returns its conversationId even when inference fails. Keep that ID so an
    // error response reloads the durable question instead of clearing it.
    if (body.conversationId) {
      activeConversationId = body.conversationId;
      persistedByServer = true;
    }
    if (!response.ok) throw new Error(body.error || t('ai.chat.failed'));
    await loadConversations();
    await refreshAiUsage();
  } catch (cause) {
    error.textContent = cause.message || t('ai.chat.failed');
    error.classList.add('is-visible');
    if (persistedByServer) {
      // Show the append-only user/failed-assistant records written by the
      // server. If that reload also fails, keep the optimistic question visible
      // and replace only the thinking indicator with a failed state.
      try {
        await loadConversations();
      } catch {
        markPendingExchangeFailed();
      }
    } else {
      // The request did not reach a persistence boundary. Restore the previous
      // conversation and put the question back so the user can retry it.
      if (activeConversationId) await loadConversation(activeConversationId).catch(() => {});
      else renderChatMessages([]);
      input.value = message;
    }
  } finally {
    chatController = null;
    button.disabled = false;
  }
}

async function analyzeCurrentRange() {
  if (analysisController) return;
  const now = Date.now();
  const { from, to } = selectedFactsRange(now);
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
    const cloud = CLOUD_CONSENT_PROVIDERS.includes(config.provider);
    if (cloud && !globalThis.confirm(tVars('ai.analysis.cloudConfirm', { provider: PROVIDER_LABELS[config.provider] || config.provider }))) {
      result.textContent = t('ai.analysis.cancelled');
      return;
    }
    const response = await apiFetch(`${_BASE}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withDisplayScope({ from, to, cloudConsentConfirmed: cloud, language: currentLang })),
      signal: analysisController.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.analysis.failed'));
    result.textContent = body.text;
    lastAnalysis = { text: body.text, from, to };
    meta.textContent = tVars('ai.analysis.meta', {
      provider: body.provider,
      model: body.model,
      time: new Date(body.generatedAt).toLocaleString(),
    });
    await refreshAiUsage();
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
  updateProviderLabel();
  loadConversations().catch(() => {});
  loadNotificationSettings().catch(() => {});
  if (!refreshTimer) refreshTimer = setInterval(() => refreshAiInsights({ live: true }), FALLBACK_REFRESH_MS);
}

function stopAiInsights() {
  generation++;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
}

/** Entry point for the socket: traffic arrived, the cards may be stale. */
function aiInsightsLiveTick() {
  scheduleLiveRefresh();
}

function initAiInsights() {
  // Wrapped: the click event must not arrive as the options argument.
  document.getElementById('ai-refresh-btn').addEventListener('click', () => refreshAiInsights());
  document.getElementById('ai-analyze-btn').addEventListener('click', analyzeCurrentRange);
  document.getElementById('ai-cancel-btn').addEventListener('click', () => analysisController?.abort());
  document.getElementById('ai-chat-send-btn').addEventListener('click', sendChatMessage);
  document.getElementById('ai-notification-open-btn').addEventListener('click', openNotificationSettings);
  document.querySelector('.settings-tab[data-tab="notifications"]')
    ?.addEventListener('click', loadNotificationSettings);
  document.getElementById('ai-notification-frequency').addEventListener('change', updateNotificationFrequencyFields);
  for (const id of ['ai-notification-rule-scheduled', 'ai-notification-rule-danger',
    'ai-notification-rule-new-destination', 'ai-notification-rule-increase']) {
    document.getElementById(id).addEventListener('change', updateNotificationRuleFields);
  }
  document.getElementById('ai-notification-save-btn').addEventListener('click', saveNotificationConfig);
  document.getElementById('ai-notification-confirm-btn').addEventListener('click', confirmNotificationConfig);
  document.getElementById('ai-notification-confirm-cancel-btn').addEventListener('click', closeNotificationConfirmation);
  document.getElementById('ai-notification-test-btn').addEventListener('click', () => runNotificationAction('test'));
  document.getElementById('ai-notification-run-btn').addEventListener('click', () => runNotificationAction('run'));
  document.getElementById('ai-new-chat-btn').addEventListener('click', () => {
    activeConversationId = null;
    document.getElementById('ai-conversation-select').value = '';
    renderChatMessages([]);
  });
  document.getElementById('ai-conversation-select').addEventListener('change', event => {
    loadConversation(event.target.value).catch(() => {});
  });
  document.getElementById('ai-delete-chat-btn').addEventListener('click', async () => {
    if (!activeConversationId || !globalThis.confirm(t('ai.chat.deleteConfirm'))) return;
    await apiFetch(`${_BASE}/api/ai/conversations/${encodeURIComponent(activeConversationId)}`, { method: 'DELETE' });
    activeConversationId = null;
    await loadConversations();
  });
  document.querySelectorAll('[data-ai-metric]').forEach(card => {
    card.addEventListener('click', () => {
      const metric = card.dataset.aiMetric;
      setLogThreatFilter(metric === 'warn' || metric === 'danger' ? metric : null);
      switchView('log');
    });
  });
}

initAiInsights();

export {
  aiInsightsLiveTick,
  analyzeCurrentRange,
  deltaSummary,
  loadConversations,
  renderChatMessages,
  renderFacts,
  refreshAiInsights,
  sendChatMessage,
  setAnalysisRunning,
  startAiInsights,
  stopAiInsights,
};
