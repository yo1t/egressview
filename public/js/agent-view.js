// ─── Agent view ───────────────────────────────────────────────────────────────
//
// An overview of every enrolled Agent, then one card for the Agent picked:
// whether it is delivering, and what its user chose to share of its "worth a
// look" list (P3-194), and the LAN devices that probed it (P3-191).
// Enrolment, approval and revocation stay in Settings > L3/L4. The one thing
// this screen changes is an answer to a candidate (P3-194 stage 2): the
// administrator can answer, or change the person's answer, and the Mac takes
// it in the next time it delivers.
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

// The Agents that can share a "worth a look" list (P3-194): macOS, and
// Windows from 0.1.184 (#976). Saying "not shared" for an older Windows Agent
// would send its user looking for a switch that version does not have.
const WINDOWS_SHARES_CANDIDATES_FROM = [0, 1, 184];

function versionAtLeast(version, minimum) {
  const parts = String(version || '').split('.').map(part => Number.parseInt(part, 10));
  if (parts.length < minimum.length || parts.some(Number.isNaN)) return false;
  for (let i = 0; i < minimum.length; i += 1) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

function listsCandidates(agent) {
  if (agent.platform === 'macos') return true;
  return agent.platform === 'windows' && versionAtLeast(agent.agentVersion, WINDOWS_SHARES_CANDIDATES_FROM);
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

// Saves one answer on the Hub, then redraws the card from what the Hub kept.
async function saveAnswer(report, entry, answer, note, status) {
  status.textContent = t('agents.candidates.saving');
  try {
    const response = await apiFetch(
      `${_BASE}/api/agents/outbound-candidates/${encodeURIComponent(report.agentId)}/${encodeURIComponent(entry.candidateId)}/answer`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(note === undefined ? { answer } : { answer, note }),
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = body.code === 'notes_not_shared'
        ? t('agents.candidates.notesNotShared')
        : (body.error || t('agents.candidates.saveFailed'));
      return;
    }
    entry.answer = answer;
    entry.answeredAt = body.answeredAt;
    entry.answeredOn = 'hub';
    if (note !== undefined || !answer) entry.note = answer && note ? note.trim() || null : null;
    drawView();
  } catch {
    status.textContent = t('agents.candidates.saveFailed');
  }
}

/**
 * The administrator's controls for one candidate: the two answers and taking
 * an answer back, and the note when this Mac shares notes. A note goes to the
 * Mac too, so it is offered only where the person agreed to notes travelling.
 */
function answerControls(report, entry) {
  const wrap = textElement('div', '', 'agent-candidate-controls');
  const buttons = textElement('div', '', 'agent-candidate-buttons');
  const status = textElement('div', '', 'agent-card-meta');
  status.setAttribute('role', 'status');
  const choices = [['expected', 'agents.candidates.expected'], ['investigate', 'agents.candidates.investigate']];
  if (entry.answer) choices.push([null, 'agents.candidates.clear']);
  for (const [value, key] of choices) {
    const button = textElement('button', t(key), `agent-candidate-button agent-candidate-button-${value || 'clear'}`);
    button.type = 'button';
    if (value) button.setAttribute('aria-pressed', String(entry.answer === value));
    button.addEventListener('click', () => {
      const keepNote = report.notesShared && value ? (entry.note || '') : undefined;
      saveAnswer(report, entry, value, keepNote, status);
    });
    buttons.appendChild(button);
  }
  wrap.appendChild(buttons);
  if (entry.answer && report.notesShared) {
    const label = textElement('label', t('agents.candidates.noteLabel'), 'agent-candidate-note-label');
    const field = document.createElement('textarea');
    field.className = 'agent-candidate-note-input';
    field.maxLength = 500;
    field.rows = 2;
    field.value = entry.note || '';
    label.appendChild(field);
    const save = textElement('button', t('agents.candidates.saveNote'), 'agent-candidate-button');
    save.type = 'button';
    save.addEventListener('click', () => saveAnswer(report, entry, entry.answer, field.value, status));
    wrap.append(label, save);
  } else if (entry.answer && !report.notesShared) {
    wrap.appendChild(textElement('div', t('agents.candidates.notesNotShared'), 'agent-card-meta'));
  }
  wrap.appendChild(status);
  return wrap;
}

// Candidates answered "expected" that the administrator opened, kept across
// redraws (an answer saved, the periodic refresh) so a row being edited does
// not fold shut under the cursor.
const openExpected = new Set();

/**
 * One candidate. An item answered "expected" is settled, so it folds to its
 * two summary lines and the list stays short; opening it shows the note and
 * the controls to change the answer or the note.
 */
function renderCandidate(report, entry) {
  const answer = answerOf(entry);
  const who = entry.kind === 'machine'
    ? t('agents.candidates.machine')
    : `${entry.application || '?'} → ${entry.destination || '?'}`;
  const summary = textElement('div', '', 'agent-candidate-body');
  summary.append(
    textElement('div', who, 'agent-candidate-title'),
    textElement('div', candidateLine(entry), 'agent-candidate-line')
  );
  const badge = textElement('span', t(`agents.candidates.${answer}`), `agent-answer agent-answer-${answer}`);
  const more = [];
  if (entry.note) {
    more.push(textElement('div', tVars('agents.candidates.note', { note: entry.note }), 'agent-candidate-note'));
  }
  if (entry.answeredOn === 'hub') {
    more.push(textElement('div', t('agents.candidates.answeredOnHub'), 'agent-card-meta'));
  }
  more.push(answerControls(report, entry));

  if (answer !== 'expected') {
    const row = textElement('div', '', `agent-candidate agent-candidate-${answer}`);
    summary.append(...more);
    row.append(summary, badge);
    return row;
  }
  const key = `${report.agentId}/${entry.candidateId}`;
  const row = textElement('details', '', 'agent-candidate agent-candidate-expected agent-candidate-fold');
  row.open = openExpected.has(key);
  row.addEventListener('toggle', () => {
    if (row.open) openExpected.add(key);
    else openExpected.delete(key);
  });
  const head = textElement('summary', '', 'agent-candidate-summary');
  head.append(summary, badge);
  const rest = textElement('div', '', 'agent-candidate-body agent-candidate-more');
  rest.append(...more);
  row.append(head, rest);
  return row;
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
  for (const entry of entries) list.appendChild(renderCandidate(report, entry));
  if (entries.length) {
    // The Agent now sends its whole list, which can be long. It scrolls
    // inside the card; the frame is focusable so the keyboard scrolls it too.
    const frame = textElement('div', '', 'agent-candidates-scroll');
    frame.tabIndex = 0;
    frame.setAttribute('role', 'region');
    frame.setAttribute('aria-label', t('agents.candidates.title'));
    frame.appendChild(list);
    section.appendChild(frame);
  }
  const more = (Number(report.total) || 0) - entries.length;
  if (more > 0) {
    section.appendChild(textElement('div',
      tVars('agents.candidates.more', { count: more }), 'agent-card-meta'));
  }
  return section;
}

// The Agents that count devices probing their computer (P3-191): macOS, only
// while its user has packet-header counting on, and Windows from 0.1.158
// (#841), always, from the closed-port drops Windows reports.
const WINDOWS_COUNTS_PROBES_FROM = [0, 1, 158];

function countsProbes(agent) {
  if (agent.platform === 'macos') return true;
  return agent.platform === 'windows' && versionAtLeast(agent.agentVersion, WINDOWS_COUNTS_PROBES_FROM);
}

function renderProbes(agent, probes, minPorts) {
  const section = textElement('div', '', 'agent-card-section');
  section.appendChild(textElement('div', t('agents.probes.title'), 'agent-card-section-title'));
  if (!countsProbes(agent)) {
    section.appendChild(textElement('div',
      tVars('agents.probes.unsupported', { platform: PLATFORM_NAMES[agent.platform] || agent.platform || '?' }),
      'agent-card-empty'));
    return section;
  }
  const senders = Array.isArray(probes?.senders) ? probes.senders : [];
  if (!senders.length) {
    section.appendChild(textElement('div',
      t(agent.platform === 'windows' ? 'agents.probes.noneWindows' : 'agents.probes.none'), 'agent-card-empty'));
    return section;
  }
  section.appendChild(textElement('div', tVars('agents.probes.hint', { ports: minPorts }), 'agent-card-meta'));
  const list = textElement('div', '', 'agent-candidates');
  for (const sender of senders) {
    const row = textElement('div', '', 'agent-candidate agent-probe');
    const body = textElement('div', '', 'agent-candidate-body');
    body.append(
      textElement('div', tVars('agents.probes.target', {
        source: sender.sourceAddress, local: sender.localAddress || '?',
      }), 'agent-candidate-title'),
      textElement('div', tVars('agents.probes.line', {
        protocol: String(sender.networkProtocol || '').toUpperCase(),
        ports: sender.maxPorts, windows: sender.windows, time: fmtTs(sender.lastAt),
      }), 'agent-candidate-line')
    );
    if (Array.isArray(sender.samplePorts) && sender.samplePorts.length) {
      body.appendChild(textElement('div',
        tVars('agents.probes.sample', { ports: sender.samplePorts.join(', ') }), 'agent-candidate-line'));
    }
    row.appendChild(body);
    list.appendChild(row);
  }
  section.appendChild(list);
  const more = (Number(probes.total) || 0) - senders.length;
  if (more > 0) section.appendChild(textElement('div', tVars('agents.probes.more', { count: more }), 'agent-card-meta'));
  return section;
}

// Which period the app list covers, per viewer. Storage may refuse access.
const APP_DAYS_KEY = 'egressview_agent_view_app_days';

function readAppDays() {
  try { return localStorage.getItem(APP_DAYS_KEY) === '7' ? 7 : 1; } catch { return 1; }
}

function storeAppDays(days) {
  try { localStorage.setItem(APP_DAYS_KEY, String(days)); } catch { /* per-viewer convenience only */ }
}

function periodSwitch(days, onPick = setAppDays) {
  const group = textElement('div', '', 'agent-segmented');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('agents.apps.periodLabel'));
  for (const value of [1, 7]) {
    const button = textElement('button', t(`agents.apps.period${value}`), 'agent-segmented-option');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(value === days));
    button.addEventListener('click', () => {
      if (value === days) return;
      // The section is drawn again when the answer arrives; until then it
      // fades, so the tap visibly did something even when the numbers end up
      // the same.
      const section = group.closest('.agent-card-section');
      section?.classList.add('agent-card-section-loading');
      section?.setAttribute('aria-busy', 'true');
      onPick(value);
    });
    group.appendChild(button);
  }
  return group;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// What the numbers below cover, said in full: "Last 24 hours" or "All" with
// the time it starts and why it starts there. All is at most the seven days
// the Hub keeps, and shorter when counting began later (`countedFrom`, the
// Hub starting to count or the Agent enrolling), in which case both choices
// may show the same thing; that is said too, so a switch that changes nothing
// visible is explained rather than looking broken.
function periodLines(days, countedFrom, startReason) {
  const now = Date.now();
  const periodStart = now - days * DAY_MS;
  const counted = Number(countedFrom) || 0;
  const late = counted > periodStart + 5 * 60 * 1000;
  const from = late ? counted : periodStart;
  const scope = days === 1 ? 'last24' : 'all';
  const reason = late ? (startReason === 'enrolled' ? 'SinceEnrolled' : 'SinceStart') : '';
  const lines = [textElement('div', tVars(`agents.period.${scope}${reason}`, { time: fmtTs(from) }), 'agent-period')];
  if (late && now - counted < DAY_MS) {
    lines.push(textElement('div', t(startReason === 'enrolled'
      ? 'agents.period.sameAsLast24Enrolled' : 'agents.period.sameAsLast24'), 'agent-card-meta'));
  }
  return lines;
}

// "2時間5分", "3日4時間": how long a gap lasted, to the minute.
function duration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return tVars('agents.duration.minutes', { count: total });
  const hours = Math.floor(total / 60);
  if (hours < 48) return tVars('agents.duration.hours', { hours, minutes: total % 60 });
  return tVars('agents.duration.days', { days: Math.floor(hours / 24), hours: hours % 24 });
}

function uptimePercent(report) {
  const total = Number(report?.totalSlots) || 0;
  if (!total) return null;
  return Math.floor((Math.min(Number(report.deliveredSlots) || 0, total) / total) * 1000) / 10;
}

const UPTIME_DAYS_KEY = 'egressview_agent_view_uptime_days';

function readUptimeDays() {
  try { return localStorage.getItem(UPTIME_DAYS_KEY) === '1' ? 1 : 7; } catch { return 7; }
}

function storeUptimeDays(days) {
  try { localStorage.setItem(UPTIME_DAYS_KEY, String(days)); } catch { /* per-viewer convenience only */ }
}

// How much the Agent sent to the Hub in the period: what monitoring itself
// costs the network. Observations the Hub left out for age are shown only when
// there were some, since they mean a record from this computer is missing.
function deliveryLines(delivery, days) {
  if (!delivery) return [];
  const lines = [textElement('div', tVars('agents.delivery.volume', {
    bytes: formatBytes(delivery.bytes), requests: Number(delivery.requests || 0).toLocaleString(),
  }), 'agent-delivery-volume')];
  const counted = Number(delivery.countedFrom) || 0;
  if (counted > Date.now() - days * DAY_MS + 5 * 60 * 1000) {
    lines.push(textElement('div', tVars('agents.delivery.countedFrom', { time: fmtTs(counted) }), 'agent-card-meta'));
  }
  if (Number(delivery.requestsWithoutSize) > 0) {
    lines.push(textElement('div', tVars('agents.delivery.withoutSize', {
      count: Number(delivery.requestsWithoutSize).toLocaleString(),
    }), 'agent-card-meta'));
  }
  if (Number(delivery.expired) > 0) {
    lines.push(textElement('div', tVars('agents.delivery.expired', {
      count: Number(delivery.expired).toLocaleString(),
    }), 'agent-delivery-expired'));
  }
  return lines;
}

// How much of the period the Agent's reports reached the Hub, and when they
// did not. An Agent sends only when it has flows, so a gap is a closed laptop
// as often as a stopped Agent; a router seeing the computer tells them apart.
function renderUptime(report, uptimeState) {
  const section = textElement('div', '', 'agent-card-section');
  const head = textElement('div', '', 'agent-card-section-head');
  head.append(textElement('div', t('agents.uptime.title'), 'agent-card-section-title'),
    periodSwitch(uptimeState.days, setUptimeDays));
  section.appendChild(head);
  if (!uptimeState.ok || !report) {
    section.appendChild(textElement('div', t('agents.uptime.unavailable'), 'agent-card-empty'));
    return section;
  }
  // The server starts the period at the Agent's enrollment when that is later.
  section.append(...periodLines(uptimeState.days, report.from, 'enrolled'));
  const percent = uptimePercent(report);
  const ratio = textElement('div', '', 'agent-uptime-ratio');
  ratio.appendChild(textElement('span', percent == null ? '—' : `${percent.toFixed(1)}%`, 'agent-uptime-value'));
  ratio.appendChild(textElement('span', tVars('agents.uptime.slots', {
    delivered: Number(report.deliveredSlots).toLocaleString(), total: Number(report.totalSlots).toLocaleString(),
  }), 'agent-card-meta'));
  section.appendChild(ratio);
  const bar = document.createElement('meter');
  bar.className = 'agent-app-bar agent-uptime-bar';
  bar.min = 0;
  bar.max = 100;
  bar.value = percent ?? 0;
  bar.setAttribute('aria-label', t('agents.uptime.title'));
  section.appendChild(bar);
  section.append(...deliveryLines(report.delivery, uptimeState.days));
  const gaps = Array.isArray(report.gaps) ? report.gaps : [];
  if (!gaps.length) {
    section.appendChild(textElement('div', t('agents.uptime.noGaps'), 'agent-card-meta'));
  } else {
    section.appendChild(textElement('div', tVars('agents.uptime.gapSummary', {
      count: report.gapCount, duration: duration(report.gapMinutes),
    }), 'agent-card-meta'));
    const list = textElement('ul', '', 'agent-uptime-gaps');
    for (const gap of gaps) {
      const item = textElement('li', '', `agent-uptime-gap${gap.agentStopped ? ' agent-uptime-gap-stopped' : ''}`);
      item.appendChild(textElement('div', tVars(gap.ongoing ? 'agents.uptime.gapOngoing' : 'agents.uptime.gap', {
        start: fmtTs(gap.startAt), end: fmtTs(gap.endAt), duration: duration(gap.minutes),
      }), 'agent-uptime-gap-time'));
      item.appendChild(textElement('div',
        t(gap.agentStopped ? 'agents.uptime.stopped' : 'agents.uptime.unknown'), 'agent-card-meta'));
      list.appendChild(item);
    }
    section.appendChild(list);
    if (report.gapCount > gaps.length) {
      section.appendChild(textElement('div', tVars('agents.uptime.more', { count: report.gapCount - gaps.length }), 'agent-card-meta'));
    }
  }
  section.appendChild(textElement('div', t('agents.uptime.note'), 'agent-card-meta'));
  return section;
}

function renderApps(appBytes, appState) {
  const section = textElement('div', '', 'agent-card-section');
  const head = textElement('div', '', 'agent-card-section-head');
  head.append(textElement('div', t('agents.apps.title'), 'agent-card-section-title'), periodSwitch(appState.days));
  section.appendChild(head);
  // Counting began when this Hub version first ran, so "all" may be short.
  if (appState.ok) section.append(...periodLines(appState.days, appState.startedAt, 'started'));
  if (!appState.ok) {
    section.appendChild(textElement('div', t('agents.apps.unavailable'), 'agent-card-empty'));
    return section;
  }
  const beyond = appBytes?.beyond || { bytesOut: 0, apps: [], totalApps: 0 };
  const apps = Array.isArray(beyond.apps) ? beyond.apps : [];
  if (!apps.length) {
    section.appendChild(textElement('div', t('agents.apps.none'), 'agent-card-empty'));
  } else {
    section.appendChild(textElement('div',
      tVars('agents.apps.total', { bytes: formatBytes(beyond.bytesOut), apps: beyond.totalApps }), 'agent-card-meta'));
    // Bars are scaled to the largest, so the list reads at a glance on a
    // phone where a table of numbers would not.
    const top = Math.max(1, ...apps.map(entry => Number(entry.bytesOut) || 0));
    const list = textElement('ol', '', 'agent-apps');
    for (const entry of apps) {
      const item = textElement('li', '', 'agent-app');
      const label = textElement('div', '', 'agent-app-label');
      label.append(
        textElement('span', entry.processName || entry.appIdentity, 'agent-app-name'),
        textElement('span', formatBytes(entry.bytesOut), 'agent-app-bytes')
      );
      const meter = document.createElement('meter');
      meter.className = 'agent-app-bar';
      meter.min = 0;
      meter.max = top;
      meter.value = Number(entry.bytesOut) || 0;
      meter.setAttribute('aria-hidden', 'true');
      item.title = entry.appIdentity;
      item.append(label, meter);
      list.appendChild(item);
    }
    section.appendChild(list);
    const more = (Number(beyond.totalApps) || 0) - apps.length;
    if (more > 0) section.appendChild(textElement('div', tVars('agents.apps.more', { count: more }), 'agent-card-meta'));
  }
  const privateBytes = Number(appBytes?.private?.bytesOut) || 0;
  if (privateBytes > 0) {
    section.appendChild(textElement('div',
      tVars('agents.apps.private', { bytes: formatBytes(privateBytes) }), 'agent-card-meta'));
    const unnamed = Number(appBytes.private.unnamedBytesOut) || 0;
    if (unnamed > 0) {
      section.appendChild(textElement('div',
        tVars('agents.apps.privateUnnamed', { bytes: formatBytes(unnamed) }), 'agent-card-meta'));
    }
  }
  const flows = Number(appBytes?.flows) || 0;
  if (flows > 0) {
    const counted = Number(appBytes.flowsWithBytes) || 0;
    section.appendChild(textElement('div', tVars('agents.apps.coverage', {
      percent: (Math.floor((counted / flows) * 1000) / 10).toFixed(1),
      counted: counted.toLocaleString(), flows: flows.toLocaleString(),
    }), 'agent-card-meta'));
  }
  return section;
}

function factRow(label, value, className = '') {
  const row = textElement('div', '', `agent-fact ${className}`.trim());
  const term = textElement('dt', label, 'agent-fact-label');
  const detail = textElement('dd', '', 'agent-fact-value');
  if (value instanceof Node) detail.append(value); else detail.textContent = value;
  row.append(term, detail);
  return row;
}

// What the Hub knows of the computer: what the Agent enrolled with, and the
// addresses its flows left from, with what a router recorded for the LAN one.
function renderFacts(agent, details, detailsOk, now) {
  const section = textElement('details', '', 'agent-card-section agent-facts');
  section.open = true;
  section.append(textElement('summary', t('agents.facts.title'), 'agent-card-section-title'));
  const list = textElement('dl', '', 'agent-facts-list');
  list.append(
    factRow(t('agents.facts.os'), platformLabel(agent) || '—'),
    factRow(t('agents.facts.agent'), agent.agentVersion || '—'),
    factRow(t('agents.facts.enrolled'), agent.createdAt ? fmtTs(agent.createdAt) : '—'),
    factRow(t('agents.facts.lastSeen'), agent.lastSeenAt
      ? `${fmtTs(agent.lastSeenAt)} · ${ago(agent.lastSeenAt, now)}` : t('agents.status.never')),
  );
  const notes = [];
  if (!detailsOk) {
    notes.push(t('agents.facts.unavailable'));
  } else {
    const addresses = details?.addresses || [];
    // The address a router also knows is the one on the LAN.
    const lan = addresses.find(entry => entry.device);
    if (lan) {
      const device = lan.device;
      list.append(factRow(t('agents.facts.lanAddress'), lan.address, 'agent-fact-mono'));
      if (device.mac) list.append(factRow(t('agents.facts.mac'), device.mac, 'agent-fact-mono'));
      if (device.vendor) list.append(factRow(t('agents.facts.vendor'), device.vendor));
      const names = [...new Set([device.dnsName, device.mdnsName, device.netbiosName].filter(Boolean))];
      if (names.length) list.append(factRow(t('agents.facts.names'), names.join(', ')));
    }
    const others = addresses.filter(entry => entry !== lan).map(entry => entry.address);
    if (others.length) {
      list.append(factRow(t('agents.facts.otherAddresses'), others.join(', '), 'agent-fact-mono agent-fact-wide'));
    }
    const collectors = details?.collectors || [];
    if (collectors.length) {
      list.append(factRow(t('agents.facts.collector'), collectors
        .map(name => {
          const key = `agents.facts.collector.${name}`;
          const label = t(key);
          return label === key ? name : label;
        }).join(', '), 'agent-fact-wide'));
    }
    if (!addresses.length) notes.push(t('agents.facts.noAddress'));
    else if (!lan) notes.push(t('agents.facts.noRouterMatch'));
    if (others.length) notes.push(t('agents.facts.otherHint'));
  }
  section.append(list, ...notes.map(note => textElement('div', note, 'agent-card-meta')));
  return section;
}

function renderCard(agent, report, now, probes, minPorts, appBytes, appState, details, detailsOk, uptime, uptimeState) {
  const card = textElement('article', '', 'agent-card');
  const head = textElement('div', '', 'agent-card-head');
  const title = textElement('div', '', 'agent-card-title');
  title.append(
    textElement('div', agent.hostName || agent.agentId, 'agent-card-host'),
    textElement('div', [platformLabel(agent), agent.agentVersion ? `Agent ${agent.agentVersion}` : '']
      .filter(Boolean).join(' · '), 'agent-card-meta')
  );
  head.append(title, deliveryLine(agent, now));
  // Answers waiting first, then what it sends, then what reached it. On a
  // wide card the candidates keep the left column however long they grow, and
  // what it sends, how long it reported, the device facts and the probes stack
  // on the right. A narrow card reads them in this order.
  const body = textElement('div', '', 'agent-card-body');
  const place = (section, slot) => { section.classList.add(`agent-card-slot-${slot}`); return section; };
  body.append(
    place(renderCandidates(agent, report), 'candidates'),
    place(renderApps(appBytes, appState), 'apps'),
    place(renderUptime(uptime, uptimeState), 'uptime'),
    place(renderProbes(agent, probes, minPorts), 'probes'),
    place(renderFacts(agent, details, detailsOk, now), 'facts'));
  card.append(head, body);
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
function summarize(agents, reports, now, probes = new Map()) {
  const summary = {
    agents: agents.length, delivering: 0, capable: 0, sharing: 0,
    candidates: 0, shown: 0, expected: 0, investigate: 0, unanswered: 0,
    probeSenders: 0, probedAgents: 0,
  };
  for (const agent of agents) {
    if (deliveryState(agent, now) === 'delivering') summary.delivering += 1;
    const probed = Number(probes.get(agent.agentId)?.total) || 0;
    summary.probeSenders += probed;
    if (probed > 0) summary.probedAgents += 1;
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
    kpi(t('agents.overview.probes'), summary.probeSenders,
      tVars('agents.overview.probesSub', { agents: summary.probedAgents }),
      summary.probeSenders > 0 ? 'warn' : 'neutral'),
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

function probeCell(agent, probes) {
  if (!countsProbes(agent)) return textElement('span', t('agents.short.unsupported'), 'agent-cell-muted');
  const total = Number(probes?.total) || 0;
  return textElement('span', String(total), total > 0 ? 'agent-count agent-count-warn' : 'agent-cell-muted');
}

function cell(child, className = '') {
  const td = textElement('td', '', className);
  td.appendChild(child);
  return td;
}

function uptimeCell(report) {
  const percent = uptimePercent(report);
  if (percent == null) return textElement('span', '—', 'agent-cell-muted');
  return textElement('span', `${percent.toFixed(1)}%`, percent < 90 ? 'agent-count agent-count-warn' : '');
}

// One row per Agent, so a stopped one or one with open questions stands out
// without opening each in turn. A row picks that Agent for the detail.
function renderTable(agents, reports, now, selectedId, probes, appBytes, uptimeWeek) {
  const table = textElement('table', '', 'agent-table');
  const headRow = document.createElement('tr');
  for (const [key, className] of [
    ['agents.table.agent', ''], ['agents.table.delivery', ''], ['agents.table.candidates', 'agent-table-num'],
    ['agents.candidates.investigate', 'agent-table-num'], ['agents.candidates.unanswered', 'agent-table-num'],
    ['agents.table.probes', 'agent-table-num'], ['agents.table.beyond', 'agent-table-num'],
    ['agents.table.uptime', 'agent-table-num'],
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
    const counts = [
      ['agents.table.candidates', candidateCell(agent, report)],
      ['agents.candidates.investigate', countCell(report, 'investigate', 'alert')],
      ['agents.candidates.unanswered', countCell(report, 'unanswered', 'warn')],
      ['agents.table.probes', probeCell(agent, probes.get(agent.agentId))],
      ['agents.table.beyond', textElement('span',
        appBytes.has(agent.agentId) ? formatBytes(appBytes.get(agent.agentId).beyond?.bytesOut) : '—',
        appBytes.has(agent.agentId) ? '' : 'agent-cell-muted')],
      ['agents.table.uptime', uptimeCell(uptimeWeek.get(agent.agentId))],
    ];
    // The same counts, labelled, for a phone where the columns are hidden.
    const stats = textElement('td', '', 'agent-table-stats');
    for (const [key, value] of counts) {
      const stat = textElement('span', t(key), 'agent-stat');
      stat.appendChild(textElement('span', value.textContent, 'agent-stat-value'));
      stats.appendChild(stat);
    }
    row.append(cell(name), cell(delivery), ...counts.map(([, value]) => cell(value, 'agent-table-num')), stats);
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
  const {
    agents, reports, now, probes, minPorts, appBytes, appState, details, detailsOk, uptime, uptimeState, uptimeWeek,
  } = lastView;
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
  const summary = summarize(agents, reports, now, probes);
  kpis?.replaceChildren(...renderKpis(summary));
  const tableParts = [renderTable(agents, reports, now, selected.agentId, probes, appBytes, uptimeWeek)];
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
  list.replaceChildren(renderCard(selected, reports.get(selected.agentId), now,
    probes.get(selected.agentId), minPorts, appBytes.get(selected.agentId), appState,
    details.get(selected.agentId), detailsOk, uptime.get(selected.agentId), uptimeState));
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

async function readAppBytes(days) {
  const result = await readJson(`/api/agents/app-bytes?days=${days}`).catch(() => ({ ok: false, body: {} }));
  return {
    appBytes: new Map((result.ok ? result.body.agents || [] : []).map(report => [report.agentId, report])),
    appState: { days, ok: result.ok, startedAt: result.body?.startedAt ?? null },
  };
}

// Switching the period reloads only the app list; the rest stays as it was.
async function readUptime(days) {
  const result = await readJson(`/api/agents/uptime?days=${days}`).catch(() => ({ ok: false, body: {} }));
  return {
    uptime: new Map((result.ok ? result.body.agents || [] : []).map(report => [report.agentId, report])),
    uptimeState: { days, ok: result.ok },
  };
}

// The table always shows the week; the card follows its own switch.
async function setUptimeDays(days) {
  storeUptimeDays(days);
  if (!lastView) return;
  const read = days === 7 && lastView.uptimeWeekOk
    ? { uptime: lastView.uptimeWeek, uptimeState: { days, ok: true } }
    : await readUptime(days);
  if (!lastView) return;
  Object.assign(lastView, read);
  drawView();
}

async function setAppDays(days) {
  storeAppDays(days);
  if (!lastView) return;
  const apps = await readAppBytes(days);
  if (!lastView) return;
  Object.assign(lastView, apps);
  drawView();
}

async function loadAgentView() {
  if (loading) return loading;
  const list = document.getElementById('agent-view-list');
  if (!list) return null;
  loading = (async () => {
    try {
      const uptimeDays = readUptimeDays();
      const [agentsResult, candidatesResult, probesResult, apps, detailsResult, week, picked] = await Promise.all([
        readJson('/api/agents'),
        // A Hub older than P3-194 answers 404 here; the cards still show.
        readJson('/api/agents/outbound-candidates').catch(() => ({ ok: false, body: {} })),
        readJson('/api/agents/inbound-probes').catch(() => ({ ok: false, body: {} })),
        readAppBytes(readAppDays()),
        readJson('/api/agents/details').catch(() => ({ ok: false, body: {} })),
        readUptime(7),
        uptimeDays === 7 ? null : readUptime(uptimeDays),
      ]);
      if (!agentsResult.ok) throw new Error(agentsResult.body.error || t('agents.loadFailed'));
      // By name, so the picker and the table keep their order between visits.
      const agents = liveAgents(agentsResult.body.agents)
        .sort((a, b) => String(a.hostName || '').localeCompare(String(b.hostName || '')));
      setAgentTabAgents(agents);
      const reports = new Map((candidatesResult.ok ? candidatesResult.body.agents || [] : [])
        .map(report => [report.agentId, report]));
      const probes = new Map((probesResult.ok ? probesResult.body.agents || [] : [])
        .map(report => [report.agentId, report]));
      const minPorts = Number(probesResult.body?.minPorts) || 10;
      const details = new Map((detailsResult.ok ? detailsResult.body.agents || [] : [])
        .map(report => [report.agentId, report]));
      lastView = {
        agents, reports, probes, minPorts, ...apps, details, detailsOk: detailsResult.ok,
        uptimeWeek: week.uptime, uptimeWeekOk: week.uptimeState.ok, ...(picked || week),
        now: Date.now(), selectedId: lastView?.selectedId || '',
      };
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
  // The explanation stays open on a wide screen; on a phone it would push the
  // numbers below the fold, so it starts folded there.
  const about = document.getElementById('agent-view-about');
  if (about && window.matchMedia?.('(max-width: 720px)').matches) about.open = false;
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
