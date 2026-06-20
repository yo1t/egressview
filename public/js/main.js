// ─── Main socket event handlers ───────────────────────────────────────────────

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

socket.on('notes-update', data => {
  if (data?.notes) {
    notesMap = data.notes;
    // Sync deviceId-keyed notes back into devicesData so re-opening the
    // detail panel shows the latest value without requiring a full refresh.
    for (const dev of devicesData) {
      if (dev.deviceId != null) {
        dev.note = data.notes[dev.deviceId] ?? null;
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
  if (data.partial) {
    // Merge: update/add entries without discarding older ones loaded via API
    allConnections = mergeConnections(allConnections, incoming);
  } else {
    allConnections = incoming;
    if (data.initialLoad) {
      const serverNow = data.serverTime || Date.now();
      dataRangeFrom = serverNow - 3600_000;
    } else {
      const oldest = incoming.reduce((min, c) => Math.min(min, c.lastSeen || c.firstSeen || min), Infinity);
      dataRangeFrom = Number.isFinite(oldest) ? oldest : Date.now() - 3600_000;
    }
  }
  if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
  if (!asusActive) {
    buildGraphFromConnections(); // Yamaha-only: render src IPs as devices
  } else {
    updateOrgGraph();
  }
  if (statsMode) updateStats();
  if (logMode) updateLogView();
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
        if (logMode) updateLogView();
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

// Init
resize();
