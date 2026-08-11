import { t, tVars, currentLang } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { getTimeRange } from './connections-panel.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { switchView } from './view-tabs.js?v=__ASSET_VERSION__';
import { setLogThreatFilter } from './log.js?v=__ASSET_VERSION__';
import { openSettings } from './settings.js?v=__ASSET_VERSION__';
import {
  appendDisplayScope,
  getDisplayScope,
  getDisplayScopeLabel,
  withDisplayScope,
} from './display-scope.js?v=__ASSET_VERSION__';

const REFRESH_MS = 15_000;
const METRICS = ['connections', 'devices', 'destinations', 'warn', 'danger'];
// Providers that transmit data externally and require per-request consent.
const CLOUD_CONSENT_PROVIDERS = ['anthropic', 'openai', 'bedrock'];
const PROVIDER_LABELS = { ollama: 'Ollama', anthropic: 'Anthropic', openai: 'OpenAI', bedrock: 'Amazon Bedrock' };

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost). EgressView
// is often reached over plain HTTP on a LAN IP, so fall back to getRandomValues
// (available everywhere) and finally Math.random, always emitting a valid v4 UUID.
function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function formatRange(from, to) {
  return `(${formatStamp(from)} - ${formatStamp(to)})`;
}
let refreshTimer = null;
let generation = 0;
let analysisController = null;
let activeConversationId = null;
let chatController = null;
// Text of the most recent "analyze current period" result, so the chat can
// reason about the same threats. Reset when a new analysis is run.
let lastAnalysis = null;
let aiNotificationProvider = 'disabled';
let pendingNotificationConfig = null;

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatUsd(value) {
  const amount = Number(value) || 0;
  const fractionDigits = amount > 0 && amount < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(currentLang === 'en' ? 'en-US' : 'ja-JP', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: currentLang === 'en' ? 'narrowSymbol' : 'code',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

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
    await refreshAiUsage();
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
  const range = getTimeRange();
  const from = range.from ?? now - 3600_000;
  const to = range.to ?? now;
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

async function updateProviderLabel() {
  const el = document.getElementById('ai-analysis-privacy');
  if (!el) return;
  try {
    const response = await apiFetch(`${_BASE}/api/config/ai`);
    const config = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const label = PROVIDER_LABELS[config.provider];
    // Only rename to a specific provider; leave the generic default when disabled.
    if (label) el.textContent = tVars('ai.analysis.privacyProvider', { provider: label });
  } catch { /* keep the generic default text */ }
}

function setNotificationStatus(message, failed = false) {
  const status = document.getElementById('ai-notification-status');
  status.textContent = message;
  status.classList.toggle('error', failed);
}

function nextScheduledRun(config, reference = new Date()) {
  if (!config.rules?.scheduled || config.frequency === 'off') return null;
  const [hour, minute] = config.time.split(':').map(Number);
  const candidate = new Date(reference);
  candidate.setSeconds(0, 0);
  candidate.setHours(hour, minute, 0, 0);
  if (config.frequency === 'daily' && candidate <= reference) candidate.setDate(candidate.getDate() + 1);
  if (config.frequency === 'weekly') {
    let days = (config.weekday - candidate.getDay() + 7) % 7;
    if (days === 0 && candidate <= reference) days = 7;
    candidate.setDate(candidate.getDate() + days);
  }
  return candidate;
}

function renderNotificationBrief(config, events = []) {
  const brief = document.getElementById('ai-notification-brief');
  const enabled = Object.values(config.rules || {}).filter(Boolean).length;
  const nextRun = nextScheduledRun(config);
  const last = events[0];
  brief.textContent = tVars('ai.notification.brief', {
    enabled,
    next: nextRun ? nextRun.toLocaleString() : t('ai.notification.summary.none'),
    last: last ? t(`ai.notification.status.${last.status}`) : t('ai.notification.summary.none'),
  });
}

function updateNotificationFrequencyFields() {
  const scheduled = document.getElementById('ai-notification-rule-scheduled').checked;
  const frequency = document.getElementById('ai-notification-frequency');
  frequency.disabled = !scheduled;
  if (scheduled && frequency.value === 'off') frequency.value = 'daily';
  const weekly = scheduled && frequency.value === 'weekly';
  document.getElementById('ai-notification-weekday-group').classList.toggle('is-hidden', !weekly);
  document.getElementById('ai-notification-weekday').disabled = !weekly;
  document.getElementById('ai-notification-time').disabled = !scheduled;
}

function updateNotificationRuleFields() {
  updateNotificationFrequencyFields();
  const mappings = [
    ['ai-notification-rule-danger', 'ai-notification-danger'],
    ['ai-notification-rule-new-destination', 'ai-notification-new-dst'],
    ['ai-notification-rule-increase', 'ai-notification-increase'],
  ];
  for (const [ruleId, inputId] of mappings) {
    document.getElementById(inputId).disabled = !document.getElementById(ruleId).checked;
  }
}

function fillNotificationConfig(config) {
  const rules = config.rules || {
    scheduled: config.frequency !== 'off',
    danger: config.threat.enabled,
    newDestination: config.threat.enabled,
    increase: config.threat.enabled,
  };
  document.getElementById('ai-notification-frequency').value = config.frequency;
  document.getElementById('ai-notification-weekday').value = String(config.weekday);
  document.getElementById('ai-notification-time').value = config.time;
  document.getElementById('ai-notification-range').value = String(config.rangeHours);
  document.getElementById('ai-notification-ui').checked = config.destinations.ui;
  document.getElementById('ai-notification-slack').checked = config.destinations.slack;
  document.getElementById('ai-notification-rule-scheduled').checked = rules.scheduled;
  document.getElementById('ai-notification-rule-danger').checked = rules.danger;
  document.getElementById('ai-notification-rule-new-destination').checked = rules.newDestination;
  document.getElementById('ai-notification-rule-increase').checked = rules.increase;
  document.getElementById('ai-notification-danger').value = String(config.threat.dangerThreshold);
  document.getElementById('ai-notification-new-dst').value = String(config.threat.newDestinationsThreshold);
  document.getElementById('ai-notification-increase').value = String(config.threat.increaseThreshold);
  document.getElementById('ai-notification-limit').value = String(config.dailyLimit);
  document.getElementById('ai-notification-cooldown').value = String(config.cooldownMinutes);
  document.getElementById('ai-notification-consent').checked = config.automationConsent;
  document.getElementById('ai-notification-timezone').textContent = tVars('ai.notification.timezone', {
    timezone: config.timezone,
  });
  updateNotificationRuleFields();
}

function notificationConfigFromForm() {
  const rules = {
    scheduled: document.getElementById('ai-notification-rule-scheduled').checked,
    danger: document.getElementById('ai-notification-rule-danger').checked,
    newDestination: document.getElementById('ai-notification-rule-new-destination').checked,
    increase: document.getElementById('ai-notification-rule-increase').checked,
  };
  return {
    frequency: document.getElementById('ai-notification-frequency').value,
    weekday: Number(document.getElementById('ai-notification-weekday').value),
    time: document.getElementById('ai-notification-time').value,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    rangeHours: Number(document.getElementById('ai-notification-range').value),
    destinations: {
      ui: document.getElementById('ai-notification-ui').checked,
      slack: document.getElementById('ai-notification-slack').checked,
    },
    rules,
    threat: {
      enabled: rules.danger || rules.newDestination || rules.increase,
      dangerThreshold: Number(document.getElementById('ai-notification-danger').value),
      newDestinationsThreshold: Number(document.getElementById('ai-notification-new-dst').value),
      increaseThreshold: Number(document.getElementById('ai-notification-increase').value),
    },
    dailyLimit: Number(document.getElementById('ai-notification-limit').value),
    cooldownMinutes: Number(document.getElementById('ai-notification-cooldown').value),
    automationConsent: document.getElementById('ai-notification-consent').checked,
  };
}

function notificationSummaryRows(config) {
  const destinations = [
    config.destinations.ui ? t('ai.notification.destination.ui') : '',
    config.destinations.slack ? t('ai.notification.destination.slack') : '',
  ].filter(Boolean).join(', ') || t('ai.notification.summary.none');
  const rows = [
    {
      label: t('ai.notification.summary.schedule'),
      value: t(config.rules.scheduled
        ? `ai.notification.frequency.${config.frequency}`
        : 'ai.notification.summary.disabled'),
    },
  ];
  const enabledRules = [
    config.rules.scheduled ? t('ai.notification.rule.scheduled') : '',
    config.rules.danger ? t('ai.notification.rule.danger') : '',
    config.rules.newDestination ? t('ai.notification.rule.newDestination') : '',
    config.rules.increase ? t('ai.notification.rule.increase') : '',
  ].filter(Boolean).join(', ') || t('ai.notification.summary.none');
  rows.unshift({ label: t('ai.notification.summary.events'), value: enabledRules });
  if (config.rules.scheduled && config.frequency !== 'off') {
    if (config.frequency === 'weekly') {
      rows.push({
        label: t('ai.notification.weekday'),
        value: t(`ai.notification.weekday.${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][config.weekday]}`),
      });
    }
    rows.push({
      label: t('ai.notification.summary.time'),
      value: `${config.time} (${config.timezone})`,
    });
    rows.push({
      label: t('ai.notification.summary.range'),
      value: t(`ai.notification.range.${config.rangeHours === 168 ? '7d' : `${config.rangeHours}h`}`),
    });
  }
  rows.push(
    { label: t('ai.notification.summary.destinations'), value: destinations },
    {
      label: t('ai.notification.summary.threat'),
      value: t((config.rules.danger || config.rules.newDestination || config.rules.increase)
        ? 'ai.notification.summary.enabled'
        : 'ai.notification.summary.disabled'),
    },
  );
  if (config.rules.danger || config.rules.newDestination || config.rules.increase) {
    rows.push({
      label: t('ai.notification.summary.thresholds'),
      value: tVars('ai.notification.summary.thresholdValues', {
        danger: config.threat.dangerThreshold,
        destinations: config.threat.newDestinationsThreshold,
        increase: config.threat.increaseThreshold,
      }),
    });
  }
  rows.push(
    {
      label: t('ai.notification.summary.limits'),
      value: tVars('ai.notification.summary.limitValues', {
        daily: config.dailyLimit,
        cooldown: config.cooldownMinutes,
      }),
    },
    {
      label: t('ai.notification.summary.consent'),
      value: t(config.automationConsent
        ? 'ai.notification.summary.enabled'
        : 'ai.notification.summary.disabled'),
    },
  );
  return rows;
}

function renderNotificationSummary(config) {
  const container = document.getElementById('ai-notification-summary');
  const rows = notificationSummaryRows(config).map(({ label, value }) => {
    const row = document.createElement('div');
    row.className = 'ai-notification-summary-row';
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    row.replaceChildren(term, detail);
    return row;
  });
  container.replaceChildren(...rows);
}

function closeNotificationConfirmation() {
  pendingNotificationConfig = null;
  document.getElementById('ai-notification-confirm-modal').classList.add('is-hidden');
  const status = document.getElementById('ai-notification-confirm-status');
  status.textContent = '';
  status.classList.remove('is-visible', 'err', 'ok');
}

function renderNotificationEvents(events) {
  const container = document.getElementById('ai-notification-events');
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'ai-analysis-meta';
    empty.textContent = t('ai.notification.history.empty');
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...events.map(event => {
    const item = document.createElement('article');
    item.className = 'ai-notification-event';
    const title = document.createElement('strong');
    title.textContent = tVars('ai.notification.event', {
      type: t(`ai.notification.type.${event.triggerType}`),
      status: t(`ai.notification.status.${event.status}`),
    });
    const meta = document.createElement('span');
    const identity = [event.provider, event.model].filter(Boolean).join(' / ');
    meta.textContent = `${new Date(event.createdAt).toLocaleString()}${identity ? ` · ${identity}` : ''}` +
      `${event.slackSent ? ` · ${t('ai.notification.slackSent')}` : ''}`;
    const children = [title, meta];
    if (event.body) {
      const body = document.createElement('pre');
      body.textContent = event.body;
      children.push(body);
    } else if (event.errorCode) {
      const error = document.createElement('span');
      error.textContent = event.errorCode;
      children.push(error);
    }
    item.replaceChildren(...children);
    return item;
  }));
}

async function loadNotificationEvents() {
  const response = await apiFetch(`${_BASE}/api/ai/notification-events?limit=10`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || t('ai.notification.loadFailed'));
  renderNotificationEvents(body.events || []);
}

async function loadNotificationSettings() {
  setNotificationStatus('');
  try {
    const response = await apiFetch(`${_BASE}/api/ai/notification-config`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.notification.loadFailed'));
    aiNotificationProvider = body.status?.provider || 'disabled';
    fillNotificationConfig(body.config);
    const eventsResponse = await apiFetch(`${_BASE}/api/ai/notification-events?limit=10`);
    const eventsBody = await eventsResponse.json().catch(() => ({}));
    if (!eventsResponse.ok) throw new Error(eventsBody.error || t('ai.notification.loadFailed'));
    const events = eventsBody.events || [];
    renderNotificationEvents(events);
    renderNotificationBrief(body.config, events);
  } catch (cause) {
    setNotificationStatus(cause.message || t('ai.notification.loadFailed'), true);
  }
}

async function openNotificationSettings() {
  openSettings('notifications');
  await loadNotificationSettings();
  document.getElementById('ai-notification-settings').focus?.();
}

function saveNotificationConfig() {
  pendingNotificationConfig = notificationConfigFromForm();
  renderNotificationSummary(pendingNotificationConfig);
  const status = document.getElementById('ai-notification-confirm-status');
  status.textContent = '';
  status.classList.remove('is-visible', 'err', 'ok');
  document.getElementById('ai-notification-confirm-modal').classList.remove('is-hidden');
}

async function confirmNotificationConfig() {
  if (!pendingNotificationConfig) return;
  const button = document.getElementById('ai-notification-confirm-btn');
  button.disabled = true;
  const status = document.getElementById('ai-notification-confirm-status');
  status.textContent = t('ai.notification.saving');
  status.className = 'settings-status is-visible';
  try {
    const config = pendingNotificationConfig;
    const response = await apiFetch(`${_BASE}/api/ai/notification-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.notification.saveFailed'));
    const verifyResponse = await apiFetch(`${_BASE}/api/ai/notification-config`);
    const verified = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || !verified.config) {
      throw new Error(verified.error || t('ai.notification.saveFailed'));
    }
    fillNotificationConfig(verified.config);
    closeNotificationConfirmation();
    setNotificationStatus(t('ai.notification.saved'));
  } catch (cause) {
    status.textContent = cause.message || t('ai.notification.saveFailed');
    status.className = 'settings-status is-visible err';
  } finally {
    button.disabled = false;
  }
}

async function runNotificationAction(kind) {
  const button = document.getElementById(
    kind === 'test' ? 'ai-notification-test-btn' : 'ai-notification-run-btn'
  );
  if (kind === 'run' && CLOUD_CONSENT_PROVIDERS.includes(aiNotificationProvider)
    && !globalThis.confirm(tVars('ai.analysis.cloudConfirm', {
      provider: PROVIDER_LABELS[aiNotificationProvider] || aiNotificationProvider,
    }))) return;
  button.disabled = true;
  setNotificationStatus(t(kind === 'test' ? 'ai.notification.testing' : 'ai.notification.running'));
  try {
    const endpoint = kind === 'test' ? 'notification-test' : 'notification-run-now';
    const response = await apiFetch(`${_BASE}/api/ai/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kind === 'run'
        ? { cloudConsentConfirmed: CLOUD_CONSENT_PROVIDERS.includes(aiNotificationProvider) }
        : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.notification.actionFailed'));
    setNotificationStatus(t(kind === 'test' ? 'ai.notification.tested' : 'ai.notification.completed'));
    await Promise.all([loadNotificationEvents(), refreshAiUsage()]);
  } catch (cause) {
    setNotificationStatus(cause.message || t('ai.notification.actionFailed'), true);
    await loadNotificationEvents().catch(() => {});
  } finally {
    button.disabled = false;
  }
}

function startAiInsights() {
  refreshAiInsights();
  updateProviderLabel();
  loadConversations().catch(() => {});
  loadNotificationSettings().catch(() => {});
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
  analyzeCurrentRange,
  confirmNotificationConfig,
  deltaSummary,
  fillNotificationConfig,
  loadConversations,
  openNotificationSettings,
  renderAiUsage,
  renderChatMessages,
  renderFacts,
  renderNotificationEvents,
  renderNotificationBrief,
  renderNotificationSummary,
  refreshAiInsights,
  refreshAiUsage,
  saveNotificationConfig,
  sendChatMessage,
  setAnalysisRunning,
  startAiInsights,
  stopAiInsights,
};
