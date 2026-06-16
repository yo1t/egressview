// ─── View tabs ────────────────────────────────────────────────────────────────
var currentView = 'graph';
var statsMode = false;
var logMode = false;
var devicesMode = false;
function switchView(view) {
  currentView = view;
  statsMode   = (view === 'stats');
  logMode     = (view === 'log');
  devicesMode = (view === 'devices');
  if (typeof nlMode !== 'undefined') nlMode = (view === 'notif-log');
  document.getElementById('graph-container').style.display        = view === 'graph'     ? 'flex' : 'none';
  document.getElementById('stats-container').style.display        = view === 'stats'     ? 'flex' : 'none';
  document.getElementById('log-container').style.display          = view === 'log'       ? 'flex' : 'none';
  document.getElementById('devices-container').style.display      = view === 'devices'   ? 'flex' : 'none';
  document.getElementById('notif-log-container').style.display    = view === 'notif-log' ? 'flex' : 'none';
  document.getElementById('btn-graph').classList.toggle('active',     view === 'graph');
  document.getElementById('btn-stats').classList.toggle('active',     view === 'stats');
  document.getElementById('btn-log').classList.toggle('active',       view === 'log');
  document.getElementById('btn-devices').classList.toggle('active',   view === 'devices');
  document.getElementById('btn-notif-log').classList.toggle('active', view === 'notif-log');
  document.body.classList.toggle('is-stats-mode', view === 'stats');
  if (view === 'graph')     requestAnimationFrame(scheduleGraphAutoFit);
  if (view === 'stats')     requestAnimationFrame(updateStats);
  else { if (typeof stStopSpin === 'function') stStopSpin(); if (typeof stStopFlatAnim === 'function') stStopFlatAnim(); }
  if (view === 'log')       requestAnimationFrame(() => { updateLogView(); loadBeacons(); });
  if (view === 'devices')   requestAnimationFrame(loadDevicesView);
  if (view === 'notif-log') requestAnimationFrame(loadNotifLog);
}
document.getElementById('btn-graph').addEventListener('click',     () => switchView('graph'));
document.getElementById('btn-stats').addEventListener('click',     () => switchView('stats'));
document.getElementById('btn-log').addEventListener('click',       () => switchView('log'));
document.getElementById('btn-devices').addEventListener('click',   () => switchView('devices'));
document.getElementById('btn-notif-log').addEventListener('click', () => switchView('notif-log'));

// ─── Device search ────────────────────────────────────────────────────────────
document.getElementById('device-search-input').addEventListener('input', () => {
  applyFilter(lastClients);
  applyGraphFilter();
});
