// ─── Agent view ───────────────────────────────────────────────────────────────
//
// An overview of every enrolled Agent, then one card for the Agent picked:
// whether it is delivering, and what its user chose to share of its "worth a
// look" list (P3-194). Enrolment, approval and revocation stay in
// Settings > L3/L4, so this screen is for reading only.
//
// The tab is shown only when /api/agents answers, which needs auth.admin, and
// lists at least one enrolled Agent. A Hub fed only by routers does not grow a
// tab it has no use for, and the note an Agent's user shares is not shown to
// anyone the Agent's privacy text does not name (the Hub's administrator).

import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtTs } from './utils.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';

// The sender's longest backoff. Inside it a quiet Agent is still delivering,
// the same yardstick the AI view's collection strip uses.
const DELIVERING_WITHIN_MS = 15 * 60 * 1000;

let onTabHidden = null;
let loading = null;

function textElement(tag, text, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text == null ? '' : String(text);
  return element;
}

function liveAgents(agents) {
  return (Array.isArray(agents) ? agents : []).filter(agent => agent && !agent.revokedAt);
}

/**
 * Shows or hides the tab for the Agents the Hub knows about. Called with the
 * list every time another screen loads it, so enrolling the first Agent or
 * revoking the last one changes the tab without a reload.
 */
function setAgentTabAgents(agents) {
  const button = document.getElementById('btn-agents');
  if (!button) return;
  const show = liveAgents(agents).length > 0;
  button.hidden = !show;
  if (!show && button.classList.contains('active')) onTabHidden?.();
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = bytes;
  let unit = -1;
  do { scaled /= 1000; unit += 1; } while (scaled >= 1000 && unit < units.length - 1);
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}

// The day is a UTC day on the Agent, so it is shown as one.
function formatDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function candidateLine(entry) {
  const vars = {
    day: formatDay(entry.day),
    bytes: formatBytes(entry.bytesOut),
    usual: formatBytes(entry.usualBytesOut),
  };
  if (entry.kind === 'newPair') return tVars('agents.candidates.newPair', vars);
  if (entry.kind === 'machine') return tVars('agents.candidates.machineAmount', vars);
  return tVars('agents.candidates.aboveUsual', vars);
}

// Only the macOS Agent builds a "worth a look" list (P3-194). Saying "not
// shared" for a Windows Agent would send its user looking for a switch
// that does not exist.
function listsCandidates(agent) {
  return agent.platform === 'macos';
}

const PLATFORM_NAMES = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

// "Microsoft Windows NT 10.0.26300.0" says the platform twice; keep the version.
function platformLabel(agent) {
  const name = PLATFORM_NAMES[agent.platform] || agent.platform || '';
  const version = String(agent.osVersion || '').replace(/^Microsoft Windows NT\s+/i, '');
  return [name, version].filter(Boolean).join(' ');
}

function deliveryState(agent, now) {
  const lastSeenAt = Number(agent.lastSeenAt) || 0;
  if (!lastSeenAt) return 'never';
  return now - lastSeenAt <= DELIVERING_WITHIN_MS ? 'delivering' : 'stopped';
}

function ago(ms, now) {
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  if (minutes < 1) return t('agents.ago.now');
  if (minutes < 60) return tVars('agents.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return tVars('agents.ago.hours', { count: hours });
  return tVars('agents.ago.days', { count: Math.floor(hours / 24) });
}

function statusPill(state, text) {
  const pill = textElement('span', '', `agent-pill agent-pill-${state}`);
  pill.append(textElement('span', '', 'agent-pill-dot'), textElement('span', text));
  return pill;
}

function deliveryLine(agent, now) {
  const lastSeenAt = Number(agent.lastSeenAt) || 0;
  const state = deliveryState(agent, now);
  if (state === 'never') return statusPill(state, t('agents.status.never'));
  return statusPill(state, tVars(`agents.status.${state}`, { time: fmtTs(lastSeenAt) }));
}

function renderCandidates(agent, report) {
  const section = textElement('div', '', 'agent-card-section');
  section.appendChild(textElement('div', t('agents.candidates.title'), 'agent-card-section-title'));
  if (!listsCandidates(agent)) {
    section.appendChild(textElement('div',
      tVars('agents.candidates.unsupported', { platform: PLATFORM_NAMES[agent.platform] || agent.platform || '?' }),
      'agent-card-empty'));
    return section;
  }
  if (!report) {
    section.appendChild(textElement('div', t('agents.candidates.notShared'), 'agent-card-empty'));
    return section;
  }
  // While learning there is nothing to count, and "0" would read as
  // "nothing unusual".
  section.appendChild(textElement('div', report.state === 'learning'
    ? tVars('agents.candidates.receivedOnly', { time: fmtTs(report.receivedAt) })
    : tVars('agents.candidates.received', { time: fmtTs(report.receivedAt), total: report.total }),
  'agent-card-meta'));
  if (report.state === 'learning') {
    section.appendChild(textElement('div', t('agents.candidates.learning'), 'agent-card-empty'));
  } else if (report.state === 'lowByteCoverage') {
    section.appendChild(textElement('div', t('agents.candidates.lowCoverage'), 'agent-card-caution'));
  }
  const entries = Array.isArray(report.entries) ? report.entries : [];
  if (!entries.length && report.state !== 'learning') {
    section.appendChild(textElement('div', t('agents.candidates.empty'), 'agent-card-empty'));
  }
  const list = textElement('div', '', 'agent-candidates');
  for (const entry of entries) {
    const answer = answerOf(entry);
    const row = textElement('div', '', `agent-candidate agent-candidate-${answer}`);
    const details = textElement('div', '', 'agent-candidate-body');
    const who = entry.kind === 'machine'
      ? t('agents.candidates.machine')
      : `${entry.application || '?'} → ${entry.destination || '?'}`;
    details.append(
      textElement('div', who, 'agent-candidate-title'),
      textElement('div', candidateLine(entry), 'agent-candidate-line')
    );
    if (entry.note) {
      details.appendChild(textElement('div',
        tVars('agents.candidates.note', { note: entry.note }), 'agent-candidate-note'));
    }
    row.append(details, textElement('span', t(`agents.candidates.${answer}`),
      `agent-answer agent-answer-${answer}`));
    list.appendChild(row);
  }
  if (entries.length) section.appendChild(list);
  const more = (Number(report.total) || 0) - entries.length;
  if (more > 0) {
    section.appendChild(textElement('div',
      tVars('agents.candidates.more', { count: more }), 'agent-card-meta'));
  }
  return section;
}

function renderCard(agent, report, now) {
  const card = textElement('article', '', 'agent-card');
  const head = textElement('div', '', 'agent-card-head');
  const title = textElement('div', '', 'agent-card-title');
  title.append(
    textElement('div', agent.hostName || agent.agentId, 'agent-card-host'),
    textElement('div', [platformLabel(agent), agent.agentVersion ? `Agent ${agent.agentVersion}` : '']
      .filter(Boolean).join(' · '), 'agent-card-meta')
  );
  head.append(title, deliveryLine(agent, now));
  card.append(head, renderCandidates(agent, report));
  return card;
}

// Which Agent the detail shows, kept for this viewer only. Storage can be
// missing or refuse access (private windows), so every use is guarded.
const SELECTED_KEY = 'egressview_agent_view_selected';

function readSelected() {
  try { return localStorage.getItem(SELECTED_KEY) || ''; } catch { return ''; }
}

function storeSelected(agentId) {
  try { localStorage.setItem(SELECTED_KEY, agentId); } catch { /* per-viewer convenience only */ }
}

// The last answer, so picking another Agent redraws without a request.
let lastView = null;

function answerOf(entry) {
  return entry.answer === 'expected' || entry.answer === 'investigate' ? entry.answer : 'unanswered';
}

/**
 * Totals across every Agent. Candidate counts come from each report's total,
 * but answers are known only for the entries that reached the Hub, so the
 * answer counts say how many entries they cover when that is fewer.
 */
function summarize(agents, reports, now) {
  const summary = {
    agents: agents.length, delivering: 0, capable: 0, sharing: 0,
    candidates: 0, shown: 0, expected: 0, investigate: 0, unanswered: 0,
  };
  for (const agent of agents) {
    if (deliveryState(agent, now) === 'delivering') summary.delivering += 1;
    if (listsCandidates(agent)) summary.capable += 1;
    const report = reports.get(agent.agentId);
    if (!report) continue;
    summary.sharing += 1;
    if (report.state === 'learning') continue;
    const entries = Array.isArray(report.entries) ? report.entries : [];
    summary.candidates += Math.max(Number(report.total) || 0, entries.length);
    summary.shown += entries.length;
    for (const entry of entries) summary[answerOf(entry)] += 1;
  }
  return summary;
}

function kpi(label, value, sub, tone) {
  const box = textElement('div', '', `agent-kpi agent-kpi-${tone}`);
  box.append(textElement('div', label, 'agent-kpi-label'), textElement('div', value, 'agent-kpi-value'));
  box.appendChild(textElement('div', sub || ' ', 'agent-kpi-sub'));
  return box;
}

function renderKpis(summary) {
  const shared = summary.sharing > 0;
  const stopped = summary.agents - summary.delivering;
  return [
    kpi(t('agents.overview.agents'), summary.agents,
      tVars('agents.overview.delivery', { delivering: summary.delivering, stopped }),
      stopped > 0 ? 'warn' : 'ok'),
    kpi(t('agents.candidates.title'), shared ? summary.candidates : '—',
      shared
        ? tVars('agents.overview.sharing', { sharing: summary.sharing, total: summary.capable })
        : t('agents.overview.noneShared'),
      'info'),
    kpi(t('agents.candidates.investigate'), shared ? summary.investigate : '—', '',
      summary.investigate > 0 ? 'alert' : 'neutral'),
    kpi(t('agents.candidates.unanswered'), shared ? summary.unanswered : '—', '',
      summary.unanswered > 0 ? 'warn' : 'neutral'),
    kpi(t('agents.candidates.expected'), shared ? summary.expected : '—', '', 'ok'),
  ];
}

function candidateCell(agent, report) {
  if (!listsCandidates(agent)) return textElement('span', t('agents.short.unsupported'), 'agent-cell-muted');
  if (!report) return textElement('span', t('agents.short.notShared'), 'agent-cell-muted');
  if (report.state === 'learning') return textElement('span', t('agents.short.learning'), 'agent-cell-muted');
  const entries = Array.isArray(report.entries) ? report.entries : [];
  return textElement('span', String(Math.max(Number(report.total) || 0, entries.length)));
}

function countCell(report, answer, tone) {
  if (!report || report.state === 'learning') return textElement('span', '—', 'agent-cell-muted');
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const count = entries.filter(entry => answerOf(entry) === answer).length;
  return textElement('span', String(count), count > 0 ? `agent-count agent-count-${tone}` : 'agent-cell-muted');
}

function cell(child, className = '') {
  const td = textElement('td', '', className);
  td.appendChild(child);
  return td;
}

// One row per Agent, so a stopped one or one with open questions stands out
// without opening each in turn. A row picks that Agent for the detail.
function renderTable(agents, reports, now, selectedId) {
  const table = textElement('table', '', 'agent-table');
  const headRow = document.createElement('tr');
  for (const [key, className] of [
    ['agents.table.agent', ''], ['agents.table.delivery', ''], ['agents.table.candidates', 'agent-table-num'],
    ['agents.candidates.investigate', 'agent-table-num'], ['agents.candidates.unanswered', 'agent-table-num'],
  ]) {
    const th = textElement('th', t(key), className);
    th.scope = 'col';
    headRow.appendChild(th);
  }
  const thead = document.createElement('thead');
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  for (const agent of agents) {
    const report = reports.get(agent.agentId);
    const state = deliveryState(agent, now);
    const row = document.createElement('tr');
    if (agent.agentId === selectedId) row.setAttribute('aria-current', 'true');
    row.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      selectAgent(agent.agentId);
    });
    const name = textElement('div', '', 'agent-table-name');
    const pick = textElement('button', agent.hostName || agent.agentId, 'agent-table-pick');
    pick.type = 'button';
    pick.addEventListener('click', () => selectAgent(agent.agentId));
    name.append(pick, textElement('span', platformLabel(agent), 'agent-table-os'));
    const lastSeenAt = Number(agent.lastSeenAt) || 0;
    const delivery = textElement('div', '', 'agent-table-delivery');
    delivery.appendChild(statusPill(state, t(`agents.short.${state}`)));
    if (lastSeenAt) delivery.appendChild(textElement('span', ago(lastSeenAt, now), 'agent-table-os'));
    row.append(
      cell(name),
      cell(delivery),
      cell(candidateCell(agent, report), 'agent-table-num'),
      cell(countCell(report, 'investigate', 'alert'), 'agent-table-num'),
      cell(countCell(report, 'unanswered', 'warn'), 'agent-table-num')
    );
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  const wrap = textElement('div', '', 'agent-table-wrap');
  wrap.appendChild(table);
  return wrap;
}

// Two Macs can share a name, so a repeated one carries the start of its id.
function optionLabels(agents) {
  const counts = new Map();
  for (const agent of agents) {
    const name = agent.hostName || agent.agentId;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return agents.map(agent => {
    const name = agent.hostName || agent.agentId;
    return counts.get(name) > 1 ? `${name} (${String(agent.agentId).slice(0, 8)})` : name;
  });
}

function drawView() {
  const list = document.getElementById('agent-view-list');
  const kpis = document.getElementById('agent-view-kpis');
  const overview = document.getElementById('agent-view-overview');
  const select = document.getElementById('agent-view-select');
  if (!list || !lastView) return;
  const { agents, reports, now } = lastView;
  const pickRow = select?.closest('.agent-view-pick');
  if (!agents.length) {
    kpis?.replaceChildren();
    overview?.replaceChildren(textElement('div', t('agents.none'), 'agent-card-empty'));
    if (pickRow) pickRow.hidden = true;
    list.replaceChildren();
    return;
  }
  const stored = lastView.selectedId || readSelected();
  const selected = agents.find(agent => agent.agentId === stored) || agents[0];
  lastView.selectedId = selected.agentId;
  const summary = summarize(agents, reports, now);
  kpis?.replaceChildren(...renderKpis(summary));
  const tableParts = [renderTable(agents, reports, now, selected.agentId)];
  if (summary.shown < summary.candidates) {
    tableParts.push(textElement('div',
      tVars('agents.overview.answersOf', { shown: summary.shown }), 'agent-card-meta agent-view-note'));
  }
  overview?.replaceChildren(...tableParts);
  if (select) {
    const labels = optionLabels(agents);
    select.replaceChildren(...agents.map((agent, index) => {
      const option = textElement('option', labels[index]);
      option.value = agent.agentId;
      return option;
    }));
    select.value = selected.agentId;
  }
  if (pickRow) pickRow.hidden = false;
  list.replaceChildren(renderCard(selected, reports.get(selected.agentId), now));
}

function selectAgent(agentId) {
  if (!lastView) return;
  lastView.selectedId = agentId;
  storeSelected(agentId);
  drawView();
  // Side by side the card is already in view; stacked, it is below the table.
  document.getElementById('agent-view-select')?.closest('.agent-panel')
    ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

async function readJson(path) {
  const response = await apiFetch(_BASE + path);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function loadAgentView() {
  if (loading) return loading;
  const list = document.getElementById('agent-view-list');
  if (!list) return null;
  loading = (async () => {
    try {
      const [agentsResult, candidatesResult] = await Promise.all([
        readJson('/api/agents'),
        // A Hub older than P3-194 answers 404 here; the cards still show.
        readJson('/api/agents/outbound-candidates').catch(() => ({ ok: false, body: {} })),
      ]);
      if (!agentsResult.ok) throw new Error(agentsResult.body.error || t('agents.loadFailed'));
      // By name, so the picker and the table keep their order between visits.
      const agents = liveAgents(agentsResult.body.agents)
        .sort((a, b) => String(a.hostName || '').localeCompare(String(b.hostName || '')));
      setAgentTabAgents(agents);
      const reports = new Map((candidatesResult.ok ? candidatesResult.body.agents || [] : [])
        .map(report => [report.agentId, report]));
      lastView = { agents, reports, now: Date.now(), selectedId: lastView?.selectedId || '' };
      drawView();
    } catch (error) {
      lastView = null;
      document.getElementById('agent-view-overview')?.replaceChildren();
      document.getElementById('agent-view-kpis')?.replaceChildren();
      list.replaceChildren(textElement('div', error.message || t('agents.loadFailed'), 'agent-view-error'));
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function initAgentView({ onHidden } = {}) {
  onTabHidden = typeof onHidden === 'function' ? onHidden : null;
  document.getElementById('agent-view-refresh-btn')?.addEventListener('click', () => loadAgentView());
  document.getElementById('agent-view-select')?.addEventListener('change', event => {
    selectAgent(event.target.value);
  });
  // Any screen that reads the Agent list announces it; see display-scope.js.
  window.addEventListener('egressview:agents', event => setAgentTabAgents(event.detail?.agents));
  // Labels are built from the catalog, so a language change redraws them.
  window.addEventListener('egressview:language-change', () => {
    if (document.getElementById('btn-agents')?.classList.contains('active')) drawView();
  });
}

export { initAgentView, loadAgentView, setAgentTabAgents };
