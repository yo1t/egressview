// ─── Agent view ───────────────────────────────────────────────────────────────
//
// One card per enrolled Agent: whether it is delivering, and what its user
// chose to share of its "worth a look" list (P3-194). Enrolment, approval and
// revocation stay in Settings > L3/L4, so this screen is for reading only.
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
      // By name, so a card stays where the reader last saw it.
      const agents = liveAgents(agentsResult.body.agents)
        .sort((a, b) => String(a.hostName || '').localeCompare(String(b.hostName || '')));
      setAgentTabAgents(agents);
      const reports = new Map((candidatesResult.ok ? candidatesResult.body.agents || [] : [])
        .map(report => [report.agentId, report]));
      if (!agents.length) {
        list.replaceChildren(textElement('div', t('agents.none'), 'settings-session-muted'));
        return;
      }
      const now = Date.now();
      list.replaceChildren(...agents.map(agent => renderCard(agent, reports.get(agent.agentId), now)));
    } catch (error) {
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
  // Any screen that reads the Agent list announces it; see display-scope.js.
  window.addEventListener('egressview:agents', event => setAgentTabAgents(event.detail?.agents));
  // Labels are built from the catalog, so a language change redraws them.
  window.addEventListener('egressview:language-change', () => {
    if (document.getElementById('btn-agents')?.classList.contains('active')) loadAgentView();
  });
}

export { initAgentView, loadAgentView, setAgentTabAgents };
