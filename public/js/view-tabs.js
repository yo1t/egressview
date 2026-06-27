// ─── View tabs ────────────────────────────────────────────────────────────────
import { t } from './i18n.js?v=__ASSET_VERSION__';

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
  // 端末一覧・検出ログは全件表示のため期間フィルターは無関係
  document.querySelector('.time-filter')
    ?.classList.toggle('disabled', view === 'devices' || view === 'notif-log');
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
