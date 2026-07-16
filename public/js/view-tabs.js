// ─── View tabs ────────────────────────────────────────────────────────────────

var currentView = 'graph';
var statsMode = false;
var logMode = false;
var devicesMode = false;
var nlMode = false;
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
  // Devices and notification-log views always show everything, so the time filter does not apply
  document.querySelector('.time-filter')
    ?.classList.toggle('disabled', view === 'devices' || view === 'notif-log');
  document.getElementById('graph-container').classList.toggle('view-active', view === 'graph');
  document.getElementById('stats-container').classList.toggle('view-active', view === 'stats');
  document.getElementById('log-container').classList.toggle('view-active', view === 'log');
  document.getElementById('devices-container').classList.toggle('view-active', view === 'devices');
  document.getElementById('notif-log-container').classList.toggle('view-active', view === 'notif-log');
  document.getElementById('btn-graph').classList.toggle('active',     view === 'graph');
  document.getElementById('btn-stats').classList.toggle('active',     view === 'stats');
  document.getElementById('btn-log').classList.toggle('active',       view === 'log');
  document.getElementById('btn-devices').classList.toggle('active',   view === 'devices');
  document.getElementById('btn-notif-log').classList.toggle('active', view === 'notif-log');
  document.body.classList.toggle('is-stats-mode', view === 'stats');
  if (view === 'graph')     requestAnimationFrame(() => viewTabHandlers.onGraph?.());
  if (view === 'stats')     requestAnimationFrame(() => {
    viewTabHandlers.onStats?.();
  });
  else viewTabHandlers.onLeaveStats?.();
  if (view === 'log')       requestAnimationFrame(() => viewTabHandlers.onLog?.());
  if (view === 'devices')   requestAnimationFrame(() => viewTabHandlers.onDevices?.());
  if (view === 'notif-log') requestAnimationFrame(() => viewTabHandlers.onNotifLog?.());
}

function initViewTabs() {
  if (initViewTabs._done) return;
  initViewTabs._done = true;

  document.getElementById('btn-graph').addEventListener('click',     () => switchView('graph'));
  document.getElementById('btn-stats').addEventListener('click',     () => switchView('stats'));
  document.getElementById('btn-log').addEventListener('click',       () => switchView('log'));
  document.getElementById('btn-devices').addEventListener('click',   () => switchView('devices'));
  document.getElementById('btn-notif-log').addEventListener('click', () => switchView('notif-log'));

  // ─── Device search ──────────────────────────────────────────────────────────
  document.getElementById('device-search-input').addEventListener('input', () => {
    viewTabHandlers.onDeviceSearch?.();
  });
}

initViewTabs();

export { statsMode, logMode, devicesMode, currentView, switchView, initViewTabs, nlMode, setViewTabHandlers };
export function setNlMode(v) { nlMode = v; }
