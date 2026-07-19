import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { getTimeRange } from './connections-panel.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { switchView } from './view-tabs.js?v=__ASSET_VERSION__';
import { setLogThreatFilter } from './log.js?v=__ASSET_VERSION__';

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
  const period = document.getElementById('ai-period');
  if (period) period.textContent = formatRange(from, to);
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

function renderChatMessages(messages) {
  const container = document.getElementById('ai-chat-messages');
  container.replaceChildren(...messages.map(message => {
    const item = document.createElement('div');
    item.className = `ai-chat-message is-${message.role}${message.status === 'failed' ? ' is-failed' : ''}`;
    item.textContent = message.status === 'failed' ? t('ai.chat.failed') : (message.body || '');
    return item;
  }));
  container.scrollTop = container.scrollHeight;
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
  try {
    const configResponse = await apiFetch(`${_BASE}/api/config/ai`, { signal: chatController.signal });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok) throw new Error(config.error || t('ai.chat.failed'));
    const cloud = CLOUD_CONSENT_PROVIDERS.includes(config.provider);
    if (cloud && !globalThis.confirm(tVars('ai.analysis.cloudConfirm', { provider: PROVIDER_LABELS[config.provider] || config.provider }))) return;
    const response = await apiFetch(`${_BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: activeConversationId || undefined,
        requestId: randomUuid(),
        message,
        from,
        to,
        cloudConsentConfirmed: cloud,
      }),
      signal: chatController.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('ai.chat.failed'));
    activeConversationId = body.conversationId;
    input.value = '';
    await loadConversations();
  } catch (error) {
    const display = document.getElementById('ai-error');
    display.textContent = error.message || t('ai.chat.failed');
    display.classList.add('is-visible');
    if (activeConversationId) await loadConversation(activeConversationId).catch(() => {});
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

function startAiInsights() {
  refreshAiInsights();
  updateProviderLabel();
  loadConversations().catch(() => {});
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

export { analyzeCurrentRange, deltaSummary, loadConversations, renderChatMessages, renderFacts, refreshAiInsights, sendChatMessage, setAnalysisRunning, startAiInsights, stopAiInsights };
