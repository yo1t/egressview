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

function deliveryLine(agent, now) {
  const lastSeenAt = Number(agent.lastSeenAt) || 0;
  if (!lastSeenAt) return { text: t('agents.status.never'), state: 'stopped' };
  const time = fmtTs(lastSeenAt);
  if (now - lastSeenAt <= DELIVERING_WITHIN_MS) {
    return { text: tVars('agents.status.delivering', { time }), state: 'delivering' };
  }
  return { text: tVars('agents.status.stopped', { time }), state: 'stopped' };
}

function renderCandidates(report) {
  const section = textElement('div', '', 'agent-card-section');
  section.appendChild(textElement('div', t('agents.candidates.title'), 'agent-card-section-title'));
  if (!report) {
    section.appendChild(textElement('div', t('agents.candidates.notShared'), 'settings-session-muted'));
    return section;
  }
  // While learning there is nothing to count, and "0" would read as
  // "nothing unusual".
  section.appendChild(textElement('div', report.state === 'learning'
    ? tVars('agents.candidates.receivedOnly', { time: fmtTs(report.receivedAt) })
    : tVars('agents.candidates.received', { time: fmtTs(report.receivedAt), total: report.total }),
  'settings-session-muted'));
  if (report.state === 'learning') {
    section.appendChild(textElement('div', t('agents.candidates.learning'), 'settings-session-muted'));
  } else if (report.state === 'lowByteCoverage') {
    section.appendChild(textElement('div', t('agents.candidates.lowCoverage'), 'settings-session-muted'));
  }
  const entries = Array.isArray(report.entries) ? report.entries : [];
  if (!entries.length && report.state !== 'learning') {
    section.appendChild(textElement('div', t('agents.candidates.empty'), 'settings-session-muted'));
  }
  for (const entry of entries) {
    const row = textElement('div', '', 'settings-agent-row');
    const details = textElement('span', '', 'settings-agent-details');
    const who = entry.kind === 'machine'
      ? t('agents.candidates.machine')
      : `${entry.application || '?'} → ${entry.destination || '?'}`;
    details.append(
      textElement('strong', who),
      textElement('span', candidateLine(entry), 'settings-session-muted')
    );
    if (entry.note) {
      details.appendChild(textElement('span',
        tVars('agents.candidates.note', { note: entry.note }), 'settings-agent-note'));
    }
    row.appendChild(details);
    const answer = entry.answer === 'expected' || entry.answer === 'investigate'
      ? entry.answer : 'unanswered';
    row.appendChild(textElement('span', t(`agents.candidates.${answer}`),
      `settings-agent-answer settings-agent-answer-${answer}`));
    section.appendChild(row);
  }
  const more = (Number(report.total) || 0) - entries.length;
  if (more > 0) {
    section.appendChild(textElement('div',
      tVars('agents.candidates.more', { count: more }), 'settings-session-muted'));
  }
  return section;
}

function renderCard(agent, report, now) {
  const card = textElement('section', '', 'agent-card');
  const head = textElement('div', '', 'agent-card-head');
  const delivery = deliveryLine(agent, now);
  head.append(
    textElement('strong', agent.hostName || agent.agentId, 'settings-agent-host agent-card-host'),
    textElement('span', `${agent.platform || ''} ${agent.osVersion || ''} · ${agent.agentVersion || ''}`.trim(),
      'settings-session-muted'),
    textElement('span', delivery.text, `agent-card-status agent-card-status-${delivery.state}`)
  );
  card.append(head, renderCandidates(report));
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

function deliveryState(agent, now) {
  const lastSeenAt = Number(agent.lastSeenAt) || 0;
  if (!lastSeenAt) return 'never';
  return now - lastSeenAt <= DELIVERING_WITHIN_MS ? 'delivering' : 'stopped';
}

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
    agents: agents.length, delivering: 0, sharing: 0,
    candidates: 0, shown: 0, expected: 0, investigate: 0, unanswered: 0,
  };
  for (const agent of agents) {
    if (deliveryState(agent, now) === 'delivering') summary.delivering += 1;
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

function tile(label, value, sub = '', tone = '') {
  const box = textElement('div', '', `agent-tile${tone ? ` agent-tile-${tone}` : ''}`);
  box.append(textElement('div', label, 'agent-tile-label'), textElement('div', value, 'agent-tile-value'));
  if (sub) box.appendChild(textElement('div', sub, 'agent-tile-sub'));
  return box;
}

function candidateCell(report) {
  if (!report) return t('agents.short.notShared');
  if (report.state === 'learning') return t('agents.short.learning');
  const entries = Array.isArray(report.entries) ? report.entries : [];
  return String(Math.max(Number(report.total) || 0, entries.length));
}

function countCell(report, answer) {
  if (!report || report.state === 'learning') return '—';
  const entries = Array.isArray(report.entries) ? report.entries : [];
  return String(entries.filter(entry => answerOf(entry) === answer).length);
}

function renderOverview(agents, reports, now, selectedId) {
  const summary = summarize(agents, reports, now);
  const tiles = textElement('div', '', 'agent-tiles');
  const shared = summary.sharing > 0;
  tiles.append(
    tile(t('agents.overview.agents'), summary.agents,
      tVars('agents.overview.delivery', {
        delivering: summary.delivering, stopped: summary.agents - summary.delivering,
      })),
    tile(t('agents.candidates.title'), shared ? summary.candidates : '—',
      shared
        ? tVars('agents.overview.sharing', { sharing: summary.sharing, total: summary.agents })
        : t('agents.overview.noneShared')),
    tile(t('agents.candidates.investigate'), shared ? summary.investigate : '—', '',
      summary.investigate > 0 ? 'alert' : ''),
    tile(t('agents.candidates.unanswered'), shared ? summary.unanswered : '—', '',
      summary.unanswered > 0 ? 'warn' : ''),
    tile(t('agents.candidates.expected'), shared ? summary.expected : '—')
  );
  const parts = [tiles];
  if (summary.shown < summary.candidates) {
    parts.push(textElement('div',
      tVars('agents.overview.answersOf', { shown: summary.shown }), 'settings-session-muted agent-view-note'));
  }

  // One row per Agent, so a stopped one or one with open questions stands out
  // without opening each in turn. A row's name picks it below.
  const wrap = textElement('div', '', 'agent-table-wrap');
  const table = textElement('table', '', 'agent-table');
  const headRow = document.createElement('tr');
  for (const key of ['agents.table.agent', 'agents.table.delivery', 'agents.table.candidates',
    'agents.candidates.investigate', 'agents.candidates.unanswered']) {
    const th = textElement('th', t(key));
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
    const nameCell = document.createElement('td');
    const pick = textElement('button', agent.hostName || agent.agentId, 'agent-table-pick');
    pick.type = 'button';
    pick.addEventListener('click', () => selectAgent(agent.agentId, { scroll: true }));
    nameCell.appendChild(pick);
    const investigate = countCell(report, 'investigate');
    const unanswered = countCell(report, 'unanswered');
    row.append(
      nameCell,
      textElement('td', t(`agents.short.${state}`), `agent-card-status-${state === 'delivering' ? 'delivering' : 'stopped'}`),
      textElement('td', candidateCell(report), 'agent-table-num'),
      textElement('td', investigate, `agent-table-num${Number(investigate) > 0 ? ' agent-table-alert' : ''}`),
      textElement('td', unanswered, 'agent-table-num')
    );
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  parts.push(wrap);
  return parts;
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
  const overview = document.getElementById('agent-view-overview');
  const select = document.getElementById('agent-view-select');
  if (!list || !lastView) return;
  const { agents, reports, now } = lastView;
  const pickRow = select?.closest('.agent-view-pick');
  if (!agents.length) {
    overview?.replaceChildren(textElement('div', t('agents.none'), 'settings-session-muted'));
    if (pickRow) pickRow.hidden = true;
    list.replaceChildren();
    return;
  }
  const stored = lastView.selectedId || readSelected();
  const selected = agents.find(agent => agent.agentId === stored) || agents[0];
  lastView.selectedId = selected.agentId;
  overview?.replaceChildren(...renderOverview(agents, reports, now, selected.agentId));
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

function selectAgent(agentId, { scroll = false } = {}) {
  if (!lastView) return;
  lastView.selectedId = agentId;
  storeSelected(agentId);
  drawView();
  if (scroll) document.getElementById('agent-view-select')?.scrollIntoView?.({ block: 'nearest' });
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
