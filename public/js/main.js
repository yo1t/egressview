// ─── ES Module entry point ────────────────────────────────────────────────────
import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE } from './utils.js?v=__ASSET_VERSION__';
import { allConnections, mergeConnections, setAllConnections, setDataRangeFrom, setServerTimeOffset, updateConnPanel, setFetching } from './connections-panel.js?v=__ASSET_VERSION__';
import { socket, connState, asusActive, setAsusActive, yamahaConfigured, setNotesMap, apiFetch, errorBanner, updateConnBadge, refreshAllNotes, setDevicesDataRef, routerState } from './auth-socket.js?v=__ASSET_VERSION__';
import { statsMode, setViewTabHandlers } from './view-tabs.js?v=__ASSET_VERSION__';
import { nodes, selectedMac, buildGraph, buildGraphFromConnections, updateOrgGraph, scheduleGraphAutoFit, fetchGraphSummary, clearGraphSummary, graphSummary, stopGraph, showToast, applyFilter, applyGraphFilter, lastClients, resizeGraph, setGraphDevicesDataRef } from './graph.js?v=__ASSET_VERSION__';
import { updateStats, stStopSpin, stStopFlatAnim } from './stats.js?v=__ASSET_VERSION__';
import { openSettings, showStatus } from './settings.js?v=__ASSET_VERSION__';
import { devicesData, setDevicesData, loadDevicesView, setOnDevicesLoaded, refreshDetailPanelNote } from './devices.js?v=__ASSET_VERSION__';
import { updateLogView } from './log.js?v=__ASSET_VERSION__';
import { loadNotifLog } from './notif-log.js?v=__ASSET_VERSION__';
import { refreshCurrentTimeFilterView } from './time-filter.js?v=__ASSET_VERSION__';
import { loadBeacons } from './beacon.js?v=__ASSET_VERSION__';
import './router-settings.js?v=__ASSET_VERSION__';

// ─── Cross-module reference injection ────────────────────────────────────────
// auth-socket.js and graph.js both need devicesData but can't import from devices.js
// directly (circular). Inject via setter functions.
setDevicesDataRef(devicesData);
setGraphDevicesDataRef(devicesData);
setOnDevicesLoaded(data => { setDevicesDataRef(data); setGraphDevicesDataRef(data); });
setViewTabHandlers({
  onGraph: scheduleGraphAutoFit,
  onStats: () => refreshCurrentTimeFilterView?.() || updateStats(),
  onLeaveStats: () => { stStopSpin(); stStopFlatAnim(); },
  onLog: () => { updateLogView(); loadBeacons(); },
  onDevices: loadDevicesView,
  onNotifLog: loadNotifLog,
  onDeviceSearch: () => { applyFilter(lastClients); applyGraphFilter(); },
});

// ─── Main socket event handlers ───────────────────────────────────────────────

socket.on('auth-required', () => {
  const banner = document.getElementById('disconnected-banner');
  banner.classList.add('is-visible');
  banner.querySelector('button').textContent = t('banner.button');
  banner.querySelector('button').onclick = () => openSettings('l2');
  connState.l2.ready = false;
  connState.l2.err   = 'session-expired';
  updateConnBadge('l2');
  if (asusActive) {
    stopGraph();
    setAsusActive(false); // subsequent connections-updates are treated as L3/L4-only mode
    // If any L3/L4 router is enabled, rebuild using synthetic clients
    if ((routerState.yamaha.enabled || routerState.cisco.enabled) && allConnections.length) buildGraphFromConnections();
  }
});

// Per-router ready state lives in routerState (initialized from the config
// event, updated by status events) so l3l4 = OR of both stays consistent.
function _updateL3L4State() {
  const configured = routerState.routers.length ? routerState.routers : [routerState.yamaha, routerState.cisco];
  const enabled = configured.filter(router => router.enabled);
  const ready = enabled.some(router => router.ready);
  connState.l3l4.ready   = ready;
  connState.l3l4.enabled = enabled.length > 0;
  if (ready) connState.l3l4.err = '';
  updateConnBadge('l3l4');
}

socket.on('yamaha-status', s => {
  showStatus('yamaha-status', s.message, s.ready);
  routerState.yamaha.ready = !!s.ready;
  if (!s.ready) connState.l3l4.err = s.state || 'failed';
  _updateL3L4State();
  const banner = document.getElementById('disconnected-banner');
  if (!connState.l3l4.ready && connState.l3l4.err === 'failed' && yamahaConfigured && !asusActive) {
    banner.classList.add('is-visible');
    banner.querySelector('button').textContent = t('banner.yamaha');
    banner.querySelector('button').onclick = () => openSettings('l3l4');
  }
  if (connState.l3l4.ready) banner.classList.remove('is-visible');
});

socket.on('cisco-status', s => {
  showStatus('cisco-status', s.message, s.ready);
  routerState.cisco.ready = !!s.ready;
  if (!s.ready) connState.l3l4.err = s.state || 'failed';
  _updateL3L4State();
  const banner = document.getElementById('disconnected-banner');
  if (!connState.l3l4.ready && connState.l3l4.err === 'failed' && !asusActive) {
    banner.classList.add('is-visible');
    banner.querySelector('button').textContent = t('banner.cisco');
    banner.querySelector('button').onclick = () => openSettings('l3l4');
  }
  if (connState.l3l4.ready) banner.classList.remove('is-visible');
});

socket.on('notes-update', async data => {
  if (data?.notes) {
    setNotesMap(data.notes);
    // notes-update fires only when a note is saved (low frequency), so always
    // re-fetch devices to ensure devicesData is fresh and deviceId-keyed notes
    // can be resolved to IP/MAC for the graph sidebar and detail panel.
    try {
      const res = await apiFetch(_BASE + '/api/devices');
      if (res.ok) {
        const json = await res.json();
        const newDevices = json.devices || [];
        setDevicesData(newDevices);
        setDevicesDataRef(newDevices);
        setGraphDevicesDataRef(newDevices);
        // Sync deviceId-keyed notes into the fresh array.
        for (const dev of newDevices) {
          if (dev.deviceId != null) dev.note = data.notes[dev.deviceId] ?? null;
        }
        refreshDetailPanelNote(newDevices);
      }
    } catch (_) { /* ignore — refreshAllNotes will still run */ }
  }
  refreshAllNotes();
});

socket.on('network-update', data => {
  setAsusActive(true);
  errorBanner.classList.remove('is-visible');
  connState.l2.enabled = true;
  connState.l2.ready   = true;
  connState.l2.err     = '';
  if (data.routerIp) connState.l2.ip = data.routerIp;
  updateConnBadge('l2');
  buildGraph(data);
});

socket.on('connections-update', data => {
  const enabledRouters = routerState.routers.length
    ? routerState.routers.some(router => router.enabled)
    : routerState.yamaha.enabled || routerState.cisco.enabled;
  if (!enabledRouters) return;
  const incoming = data.connections || [];
  if (data.partial || !data.initialLoad) {
    // Merge: update/add entries without discarding history or API-fetched ranges.
    setAllConnections(mergeConnections(allConnections, incoming));
  } else {
    // True initial load (initialLoad=true, partial=false): replace and reset range.
    setAllConnections(incoming);
    const serverNow = data.serverTime || Date.now();
    setDataRangeFrom(serverNow - 3600_000);
  }
  if (data.serverTime) setServerTimeOffset(data.serverTime - Date.now());
  if (!asusActive) {
    buildGraphFromConnections(); // Yamaha-only: render src IPs as devices
  } else {
    updateOrgGraph();
  }
  if (statsMode) updateStats();
  // Log view fetches independently from the API on tab-switch and filter changes;
  // calling updateLogView() here would reset pagination every 2 s and break scroll.
  // Immediately update the panel for the currently selected device
  const selNode = nodes.find(n => n.id === selectedMac);
  const selIp   = selNode?.client?.ip || null;
  updateConnPanel(selIp);

  // Initial load sent only 1h. Fetch the remaining 24h in the background
  // and merge so real-time deltas that arrived during the fetch are not lost.
  if (data.initialLoad) {
    const from24h = Date.now() - 86_400_000;
    setFetching(+1);
    apiFetch(`${_BASE}/api/connections?from=${from24h}`)
      .then(r => r.json())
      .then(async d => {
        setAllConnections(mergeConnections(allConnections, d.connections || []));
        setDataRangeFrom(from24h);
        if (d.truncated && fetchGraphSummary) {
          await fetchGraphSummary(from24h, null);
        } else if (!d.truncated && clearGraphSummary) {
          clearGraphSummary();
        }
        if (graphSummary) buildGraphFromConnections();
        else if (!asusActive) buildGraphFromConnections(); else updateOrgGraph();
        scheduleGraphAutoFit({ delayedData: true });
        if (statsMode) updateStats();
      })
      .catch(e => console.warn('[connections] background 24h fetch failed:', e))
      .finally(() => setFetching(-1));
  }
});

socket.on('poll-error', err => {
  errorBanner.textContent = tVars('err.poll', { message: err.message });
  errorBanner.classList.add('is-visible');
});

socket.on('new-device', entry => {
  const name = entry.srcMdnsName || entry.srcDnsName || entry.src;
  const vendor = entry.srcVendor ? ` — ${entry.srcVendor}` : '';
  showToast(`${t('device.new.toast')}\n${name}${vendor}`);
});

// Demo mode banner
if (typeof _DEMO_MODE !== 'undefined' && _DEMO_MODE) {
  const demoBanner = document.getElementById('demo-banner');
  if (demoBanner) demoBanner.classList.add('is-visible');
}

// Init
resizeGraph();
