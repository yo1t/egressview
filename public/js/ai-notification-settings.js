/**
 * The AI notification settings panel: schedule, rules, limits and history.
 *
 * Split out of `ai-insights.js` (P2-97). It is a different job from reading
 * insights or asking questions -- it decides when the Hub speaks on its own --
 * and it was 350 of that file's 892 lines.
 */

import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { openSettings } from './settings.js?v=__ASSET_VERSION__';
import { CLOUD_CONSENT_PROVIDERS, PROVIDER_LABELS } from './ai-providers.js?v=__ASSET_VERSION__';
import { refreshAiUsage } from './ai-usage.js?v=__ASSET_VERSION__';

let aiNotificationProvider = 'disabled';
let pendingNotificationConfig = null;

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

export {
  closeNotificationConfirmation,
  confirmNotificationConfig,
  fillNotificationConfig,
  loadNotificationEvents,
  loadNotificationSettings,
  nextScheduledRun,
  notificationConfigFromForm,
  notificationSummaryRows,
  openNotificationSettings,
  renderNotificationBrief,
  renderNotificationEvents,
  renderNotificationSummary,
  runNotificationAction,
  saveNotificationConfig,
  setNotificationStatus,
  updateNotificationFrequencyFields,
  updateNotificationRuleFields,
};
