// ─── Main socket event handlers ───────────────────────────────────────────────

function initMain() {
  if (initMain._done) return;
  initMain._done = true;

socket.on('auth-required', () => {
  const banner = document.getElementById('disconnected-banner');
  banner.style.display = 'block';
  banner.querySelector('button').textContent = t('banner.button');
  banner.querySelector('button').onclick = () => openSettings('l2');
  settingsBtn.classList.add('alert');
  connState.l2.ready = false;
  connState.l2.err   = 'session-expired';
  updateConnBadge('l2');
  if (asusActive) {
    stopGraph();
    asusActive = false; // ← subsequent connections-updates are treated as Yamaha-only mode
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
    banner.querySelector('button').onclick = () => openSettings('l3l4');
  }
  if (s.ready) {
    document.getElementById('disconnected-banner').style.display = 'none';
    settingsBtn.classList.remove('alert');
  }
});

socket.on('notes-update', async data => {
  if (data?.notes) {
    notesMap = data.notes;
    // notes-update fires only when a note is saved (low frequency), so always
    // re-fetch devices to ensure devicesData is fresh and deviceId-keyed notes
    // can be resolved to IP/MAC for the graph sidebar and detail panel.
    try {
      const res = await apiFetch(_BASE + '/api/devices');
      if (res.ok) {
        const json = await res.json();
        devicesData = json.devices || [];
      }
    } catch (_) { /* ignore — refreshAllNotes will still run */ }
    // Sync deviceId-keyed notes into devicesData.
    for (const dev of devicesData) {
      if (dev.deviceId != null) {
        dev.note = data.notes[dev.deviceId] ?? null;
      }
    }
    // If a device detail panel is currently open, refresh its note textarea.
    if (typeof dvDetailDevice !== 'undefined' && dvDetailDevice) {
      const ta = document.getElementById('dv-detail-note-ta');
      if (ta) {
        const fresh = devicesData.find(d => d.ip === dvDetailDevice.ip);
        if (fresh) {
          dvDetailDevice = fresh;
          ta.value = fresh.note ?? lookupNote(fresh.ip, fresh.mac, fresh.deviceId) ?? '';
        }
      }
    }
  }
  refreshAllNotes();
});

socket.on('network-update', data => {
  asusActive = true;
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
    // Periodic full-replace polls (partial=false, initialLoad=false) are treated
    // as merge too — overwriting would wipe 7d/14d data loaded by the time filter.
    allConnections = mergeConnections(allConnections, incoming);
    if (data.initialLoad === false) {
      // Periodic poll: advance dataRangeFrom only if it would move forward, never back.
      // (keeps timeFilterNeedsFetch() from re-fetching historical ranges unnecessarily)
    }
  } else {
    // True initial load (initialLoad=true, partial=false): replace and reset range.
    allConnections = incoming;
    const serverNow = data.serverTime || Date.now();
    dataRangeFrom = serverNow - 3600_000;
  }
  if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
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
        allConnections = mergeConnections(allConnections, d.connections || []);
        dataRangeFrom = from24h;
        if (d.truncated && typeof fetchGraphSummary === 'function') {
          await fetchGraphSummary(from24h, null);
        } else if (!d.truncated && typeof clearGraphSummary === 'function') {
          clearGraphSummary();
        }
        if (typeof graphSummary !== 'undefined' && graphSummary) buildGraphFromConnections();
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
resize();
}

initMain();

if (typeof registerEgressViewInit === 'function') registerEgressViewInit('main', initMain);
