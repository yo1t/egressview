// ─── Time filter ──────────────────────────────────────────────────────────────
async function fetchConnectionRange(from, to) {
  const params = new URLSearchParams();
  if (from != null) params.set('from', from);
  if (to   != null) params.set('to',   to);
  try {
    const res = await apiFetch(`${_BASE}/api/connections?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    allConnections = data.connections || [];
    dataRangeFrom = from != null ? from : 0;
    if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
  } catch (e) {
    console.error('[connections] fetch failed:', e);
  }
}

async function applyTimeFilter() {
  const { from, to } = getTimeRange();
  const now = Date.now() + serverTimeOffset;
  const rangeMs = from == null ? Infinity : Math.max(0, (to ?? now) - from);
  const needsFetch = from === null || from < dataRangeFrom;
  const delayedData = needsFetch || rangeMs > 24 * 3600_000;
  // If the filter requests older data than what's loaded, fetch from API
  if (needsFetch) {
    await fetchConnectionRange(from, to);
  }
  if (asusActive) updateOrgGraph();
  else            buildGraphFromConnections();
  scheduleGraphAutoFit({ delayedData });
  if (mapMode)    updateMapDots();
  if (statsMode)  updateStats();
  if (logMode)    updateLogView();
  const selNode = nodes.find(n => n.id === selectedMac);
  updateConnPanel(selNode?.client?.ip || null);
}

document.getElementById('time-filter-select').addEventListener('change', e => {
  currentTimeFilter = e.target.value;
  const customWrap = document.getElementById('custom-range');
  if (currentTimeFilter === 'custom') {
    customWrap.style.display = 'inline-flex';
    // Initial values: past 1 hour
    const now = new Date(Date.now() + serverTimeOffset);
    const past = new Date(now.getTime() - 3600_000);
    const fromEl = document.getElementById('custom-from');
    const toEl   = document.getElementById('custom-to');
    if (!fromEl.value) fromEl.value = toLocalDatetimeStr(past);
    if (!toEl.value)   toEl.value   = toLocalDatetimeStr(now);
    customRangeFrom = new Date(fromEl.value).getTime();
    customRangeTo   = new Date(toEl.value).getTime();
  } else {
    customWrap.style.display = 'none';
  }
  applyTimeFilter();
});

// Changes to the custom-period datetime-local inputs
function toLocalDatetimeStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
['custom-from', 'custom-to'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    customRangeFrom = new Date(document.getElementById('custom-from').value).getTime() || null;
    customRangeTo   = new Date(document.getElementById('custom-to').value).getTime()   || null;
    if (currentTimeFilter === 'custom') applyTimeFilter();
  });
});
