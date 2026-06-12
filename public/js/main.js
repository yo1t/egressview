// ─── Main socket event handlers ───────────────────────────────────────────────

socket.on('auth-required', () => {
  document.getElementById('disconnected-banner').style.display = 'block';
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
  connState.l3l4.err     = s.ready ? '' : 'failed';
  updateConnBadge('l3l4');
  if (!s.ready && yamahaConfigured && !asusActive) {
    const banner = document.getElementById('disconnected-banner');
    banner.style.display = 'block';
    banner.querySelector('button').textContent = t('banner.yamaha');
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
    const map = new Map(allConnections.map(c => [`${c.src}|${c.dst}|${c.dport}|${c.proto}`, c]));
    for (const c of incoming) {
      const key = `${c.src}|${c.dst}|${c.dport}|${c.proto}`;
      const prev = map.get(key);
      map.set(key, { ...prev, ...c, threat: c.threat || prev?.threat || null });
    }
    allConnections = [...map.values()];
  } else {
    allConnections = incoming;
    dataRangeFrom = 0;
  }
  if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
  if (!asusActive) {
    buildGraphFromConnections(); // Yamaha-only: render src IPs as devices
  } else {
    updateOrgGraph();
  }
  if (mapMode) updateMapDots();
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
    apiFetch(`${_BASE}/api/connections?from=${from24h}`)
      .then(r => r.json())
      .then(d => {
        const map = new Map(allConnections.map(c => [`${c.src}|${c.dst}|${c.dport}|${c.proto}`, c]));
        for (const c of d.connections || []) {
          const key = `${c.src}|${c.dst}|${c.dport}|${c.proto}`;
          const prev = map.get(key);
          map.set(key, { ...prev, ...c, threat: c.threat || prev?.threat || null });
        }
        allConnections = [...map.values()];
        dataRangeFrom = from24h;
        if (!asusActive) buildGraphFromConnections(); else updateOrgGraph();
        if (mapMode) updateMapDots();
        if (statsMode) updateStats();
        if (logMode) updateLogView();
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

// Init
resize();
