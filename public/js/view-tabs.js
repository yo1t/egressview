// ─── View tabs ────────────────────────────────────────────────────────────────
var currentView = 'graph';
var statsMode = false;
var logMode = false;
var devicesMode = false;
var dashMode = false;
function switchView(view) {
  currentView = view;
  mapMode     = (view === 'map');
  statsMode   = (view === 'stats');
  logMode     = (view === 'log');
  devicesMode = (view === 'devices');
  dashMode    = (view === 'dashboard');
  document.getElementById('graph-container').style.display     = view === 'graph'     ? 'flex' : 'none';
  document.getElementById('dashboard-container').style.display = view === 'dashboard' ? 'flex' : 'none';
  document.getElementById('map-container').style.display       = view === 'map'       ? 'flex' : 'none';
  document.getElementById('stats-container').style.display     = view === 'stats'     ? 'flex' : 'none';
  document.getElementById('log-container').style.display       = view === 'log'       ? 'flex' : 'none';
  document.getElementById('devices-container').style.display   = view === 'devices'   ? 'flex' : 'none';
  document.getElementById('btn-graph').classList.toggle('active',     view === 'graph');
  document.getElementById('btn-dashboard').classList.toggle('active', view === 'dashboard');
  document.getElementById('btn-map').classList.toggle('active',       view === 'map');
  document.getElementById('btn-stats').classList.toggle('active',     view === 'stats');
  document.getElementById('btn-log').classList.toggle('active',       view === 'log');
  document.getElementById('btn-devices').classList.toggle('active',   view === 'devices');
  document.body.classList.toggle('is-stats-mode', view === 'stats');
  if (view === 'map')     requestAnimationFrame(() => initWorldMap());
  else                    stopMapAnim();
  if (view === 'graph')   requestAnimationFrame(scheduleGraphAutoFit);
  if (view === 'dashboard') requestAnimationFrame(initDashboard);
  else if (typeof dashStopSpin === 'function') dashStopSpin();
  if (view === 'stats')   requestAnimationFrame(updateStats);
  else { if (typeof stStopSpin === 'function') stStopSpin(); if (typeof stStopFlatAnim === 'function') stStopFlatAnim(); }
  if (view === 'log')     requestAnimationFrame(() => { updateLogView(); loadBeacons(); });
  if (view === 'devices') requestAnimationFrame(loadDevicesView);
}
document.getElementById('btn-graph').addEventListener('click',     () => switchView('graph'));
document.getElementById('btn-dashboard').addEventListener('click', () => switchView('dashboard'));
document.getElementById('btn-map').addEventListener('click',       () => switchView('map'));
document.getElementById('btn-stats').addEventListener('click',     () => switchView('stats'));
document.getElementById('btn-log').addEventListener('click',     () => switchView('log'));
document.getElementById('btn-devices').addEventListener('click', () => switchView('devices'));

// ─── Device search ────────────────────────────────────────────────────────────
document.getElementById('device-search-input').addEventListener('input', () => {
  applyFilter(lastClients);
  applyGraphFilter();
});
