// ─── ES Module entry point ────────────────────────────────────────────────────
import { t, tVars } from './i18n.js';
import { _BASE } from './utils.js';
import { allConnections, mergeConnections, dataRangeFrom, serverTimeOffset, setAllConnections, setDataRangeFrom, setServerTimeOffset } from './connections-panel.js';
import { socket, connState, asusActive, setAsusActive, yamahaConfigured, notesMap, setNotesMap, adminToken, apiFetch, errorBanner, updateConnBadge, lookupNote, refreshAllNotes } from './auth-socket.js';
import { statsMode } from './view-tabs.js';
import { nodes, selectedMac, buildGraph, buildGraphFromConnections, updateOrgGraph, scheduleGraphAutoFit, fetchGraphSummary, clearGraphSummary, graphSummary, stopGraph, showToast, updateConnPanel } from './graph.js';
import { updateStats } from './stats.js';
import { openSettings, showStatus } from './settings.js';
import { setDevicesDataRef } from './auth-socket.js';
import { setGraphDevicesDataRef } from './graph.js';
import { devicesData, setDevicesData } from './devices.js';
import { initGraph, resizeGraph } from './graph.js';
import { initStats } from './stats.js';
import { initViewTabs } from './view-tabs.js';
import { initLog } from './log.js';
import { initDevices } from './devices.js';
import { initNotifLog } from './notif-log.js';
import { initTimeFilter } from './time-filter.js';

// ─── Cross-module reference injection ────────────────────────────────────────
// auth-socket.js and graph.js both need devicesData but can't import from devices.js
// directly (circular). Inject via setter functions.
setDevicesDataRef(devicesData);
setGraphDevicesDataRef(devicesData);

// ─── Main socket event handlers ───────────────────────────────────────────────

socket.on('auth-required', () => {
  const banner = document.getElementById('disconnected-banner');
  banner.style.display = 'block';
  banner.querySelector('button').textContent = t('banner.button');
  banner.querySelector('button').addEventListener('click', () => openSettings('l2'));
  connState.l2.ready = false;
  connState.l2.err   = 'session-expired';
  updateConnBadge('l2');
  if (asusActive) {
    stopGraph();
    setAsusActive(false); // subsequent connections-updates are treated as Yamaha-only mode
    // If Yamaha is enabled, rebuild using synthetic clients
    if (yamahaConfigured && allConnections.length) buildGraphFromConnections();
  }
});

socket.on('yamaha-status', s => {
  showStatus('yamaha-status', s.message, s.ready);
  connState.l3l4.enabled = yamahaConfigured;
  connState.l3l4.ready   = s.ready;
  connState.l3l4.err     = s.ready ? '' : (s.state || 'failed');
  updateConnBadge('l3l4');
  if (!s.ready && connState.l3l4.err === 'failed' && yamahaConfigured && !asusActive) {
    const banner = document.getElementById('disconnected-banner');
    banner.style.display = 'block';
    banner.querySelector('button').textContent = t('banner.yamaha');
    banner.querySelector('button').addEventListener('click', () => openSettings('l3l4'));
  }
  if (s.ready) {
    document.getElementById('disconnected-banner').style.display = 'none';
    // settingsBtn alert cleared via auth-socket updateConnBadge
  }
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
      }
    } catch (_) { /* ignore — refreshAllNotes will still run */ }
    // Sync deviceId-keyed notes into devicesData.
    for (const dev of devicesData) {
      if (dev.deviceId != null) {
        dev.note = data.notes[dev.deviceId] ?? null;
      }
    }
  }
  refreshAllNotes();
});

socket.on('network-update', data => {
  setAsusActive(true);
  errorBanner.style.display = 'none';
  connState.l2.enabled = true;
  connState.l2.ready   = true;
  connState.l2.err     = '';
  if (data.routerIp) connState.l2.ip = data.routerIp;
  updateConnBadge('l2');
  buildGraph(data);
});

socket.on('connections-update', data => {
  if (!yamahaConfigured) return; // do nothing while Yamaha is disabled
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
    // setFetching(+1) is handled inside the fetch
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
      .catch(e => console.warn('[connections] background 24h fetch failed:', e));
  }
});

socket.on('poll-error', err => {
  errorBanner.textContent = tVars('err.poll', { message: err.message });
  errorBanner.style.display = 'block';
});

socket.on('new-device', entry => {
  const name = entry.srcMdnsName || entry.srcDnsName || entry.src;
  const vendor = entry.srcVendor ? ` — ${entry.srcVendor}` : '';
  showToast(`${t('device.new.toast')}\n${name}${vendor}`);
});

// Demo mode banner
if (typeof _DEMO_MODE !== 'undefined' && _DEMO_MODE) {
  const demoBanner = document.getElementById('demo-banner');
  if (demoBanner) demoBanner.style.display = '';
}

// Init
resizeGraph();
