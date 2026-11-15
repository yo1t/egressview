// ─── View tabs ────────────────────────────────────────────────────────────────

var currentView = 'ai';
var statsMode = false;
var logMode = false;
var devicesMode = false;
var nlMode = false;
var aiMode = true;
var agentsMode = false;
var viewTabHandlers = {};

function setViewTabHandlers(handlers) {
  viewTabHandlers = { ...viewTabHandlers, ...(handlers || {}) };
}

function switchView(view) {
  currentView = view;
  statsMode   = (view === 'stats');
  logMode     = (view === 'log');
  devicesMode = (view === 'devices');
  nlMode = (view === 'notif-log');
  aiMode = (view === 'ai');
  agentsMode = (view === 'agents');
  // Devices, notification-log and Agent views do not follow the period, so the time filter does not apply
  document.querySelector('.time-filter')
    ?.classList.toggle('disabled', view === 'devices' || view === 'notif-log' || view === 'agents');
  document.getElementById('graph-container').classList.toggle('view-active', view === 'graph');
  document.getElementById('stats-container').classList.toggle('view-active', view === 'stats');
  document.getElementById('log-container').classList.toggle('view-active', view === 'log');
  document.getElementById('devices-container').classList.toggle('view-active', view === 'devices');
  document.getElementById('notif-log-container').classList.toggle('view-active', view === 'notif-log');
  document.getElementById('ai-container').classList.toggle('view-active', view === 'ai');
  document.getElementById('agents-container')?.classList.toggle('view-active', view === 'agents');
  document.getElementById('btn-graph').classList.toggle('active',     view === 'graph');
  document.getElementById('btn-stats').classList.toggle('active',     view === 'stats');
  document.getElementById('btn-log').classList.toggle('active',       view === 'log');
  document.getElementById('btn-devices').classList.toggle('active',   view === 'devices');
  document.getElementById('btn-notif-log').classList.toggle('active', view === 'notif-log');
  document.getElementById('btn-ai').classList.toggle('active', view === 'ai');
  document.getElementById('btn-agents')?.classList.toggle('active', view === 'agents');
  document.body.classList.toggle('is-stats-mode', view === 'stats');
  if (view === 'graph')     requestAnimationFrame(() => viewTabHandlers.onGraph?.());
  if (view === 'stats')     requestAnimationFrame(() => {
    viewTabHandlers.onStats?.();
  });
  else viewTabHandlers.onLeaveStats?.();
  if (view === 'log')       requestAnimationFrame(() => viewTabHandlers.onLog?.());
  if (view === 'devices')   requestAnimationFrame(() => viewTabHandlers.onDevices?.());
  if (view === 'notif-log') requestAnimationFrame(() => viewTabHandlers.onNotifLog?.());
  if (view === 'agents') requestAnimationFrame(() => viewTabHandlers.onAgents?.());
  if (view === 'ai') requestAnimationFrame(() => viewTabHandlers.onAi?.());
  else viewTabHandlers.onLeaveAi?.();
}

function initViewTabs() {
  if (initViewTabs._done) return;
  initViewTabs._done = true;

  document.getElementById('btn-graph').addEventListener('click',     () => switchView('graph'));
  document.getElementById('btn-stats').addEventListener('click',     () => switchView('stats'));
  document.getElementById('btn-log').addEventListener('click',       () => switchView('log'));
  document.getElementById('btn-devices').addEventListener('click',   () => switchView('devices'));
  document.getElementById('btn-notif-log').addEventListener('click', () => switchView('notif-log'));
  document.getElementById('btn-ai').addEventListener('click',        () => switchView('ai'));
  document.getElementById('btn-agents')?.addEventListener('click',   () => switchView('agents'));

  // ─── Device search ──────────────────────────────────────────────────────────
  document.getElementById('device-search-input').addEventListener('input', () => {
    viewTabHandlers.onDeviceSearch?.();
  });
}

initViewTabs();

export { statsMode, logMode, devicesMode, currentView, switchView, initViewTabs, nlMode, aiMode, agentsMode, setViewTabHandlers };
export function setNlMode(v) { nlMode = v; }
export function refreshAiView() { return viewTabHandlers.onAiRefresh?.(); }
