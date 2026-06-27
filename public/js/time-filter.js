// ─── Time filter ──────────────────────────────────────────────────────────────
const truncatedGraphRangeKeys = new Set();

function timeFilterRangeKey(from, to) {
  if (typeof currentGraphRangeKey === 'function') return currentGraphRangeKey(from, to);
  return `${from ?? ''}:${to ?? ''}`;
}

function rememberGraphTruncation(from, to, truncated) {
  const key = timeFilterRangeKey(from, to);
  if (truncated) truncatedGraphRangeKeys.add(key);
  else truncatedGraphRangeKeys.delete(key);
}

function needsGraphSummaryForRange(from, to) {
  const key = timeFilterRangeKey(from, to);
  return truncatedGraphRangeKeys.has(key)
    && (!(typeof graphSummary !== 'undefined' && graphSummary) || graphSummaryKey !== key);
}

async function fetchConnectionRange(from, to) {
  const params = new URLSearchParams();
  if (from != null) params.set('from', from);
  if (to   != null) params.set('to',   to);
  setFetching(+1);
  try {
    const res = await apiFetch(`${_BASE}/api/connections?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    allConnections = mergeConnections(allConnections, data.connections || []);
    // dataRangeFrom tracks the oldest timestamp for which we have continuous
    // coverage through "now". Bounded ranges such as "yesterday" must not move
    // it back, otherwise switching back to live/1h would incorrectly skip fetch.
    if (to == null) {
      dataRangeFrom = from != null ? Math.min(dataRangeFrom, from) : 0;
    }
    if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
    const notice = document.getElementById('graph-truncated-notice');
    if (notice) notice.style.display = data.truncated ? '' : 'none';
    rememberGraphTruncation(from, to, !!data.truncated);
    if (data.truncated && typeof fetchGraphSummary === 'function') {
      await fetchGraphSummary(from, to);
    } else if (!data.truncated && typeof clearGraphSummary === 'function') {
      clearGraphSummary();
    }
  } catch (e) {
    console.error('[connections] fetch failed:', e);
  } finally {
    setFetching(-1);
  }
}

let timeFilterGeneration = 0;

function renderTimeFilteredViews({ delayedData = false } = {}) {
  if (typeof graphSummary !== 'undefined' && graphSummary) buildGraphFromConnections({ resetPositions: true });
  else if (asusActive) updateOrgGraph({ resetPositions: true });
  else            buildGraphFromConnections({ resetPositions: true });
  scheduleGraphAutoFit({ delayedData });
  if (statsMode)  updateStats();
  const selNode = nodes.find(n => n.id === selectedMac);
  updateConnPanel(selNode?.client?.ip || null);
}

function timeFilterNeedsFetch() {
  const { from } = getTimeRange();
  return from === null || from < dataRangeFrom;
}

async function applyTimeFilter() {
  const generation = ++timeFilterGeneration;
  const { from, to } = getTimeRange();
  const now = Date.now() + serverTimeOffset;
  const rangeMs = from == null ? Infinity : Math.max(0, (to ?? now) - from);
  const needsFetch = timeFilterNeedsFetch();
  const delayedData = needsFetch || rangeMs > 24 * 3600_000;

  // Log view fetches its own data from the API independently — start it immediately
  // so it responds without waiting for the (potentially large) graph data fetch.
  if (logMode) updateLogView();

  if (needsFetch) {
    // Redraw immediately with locally available data, then redraw again after
    // the historical fetch finishes.
    renderTimeFilteredViews({ delayedData: false });
    await fetchConnectionRange(from, to);
    if (generation !== timeFilterGeneration) return;
    renderTimeFilteredViews({ delayedData });
  } else {
    if (needsGraphSummaryForRange(from, to) && typeof fetchGraphSummary === 'function') {
      await fetchGraphSummary(from, to);
      if (generation !== timeFilterGeneration) return;
    }
    renderTimeFilteredViews({ delayedData });
  }
}

function refreshCurrentTimeFilterView() {
  const { from, to } = getTimeRange();
  if (timeFilterNeedsFetch() || needsGraphSummaryForRange(from, to)) {
    return applyTimeFilter();
  } else {
    renderTimeFilteredViews();
    if (logMode) updateLogView();
    return Promise.resolve();
  }
}

// Changes to the custom-period datetime-local inputs
function toLocalDatetimeStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initTimeFilter() {
  if (initTimeFilter._done) return;
  initTimeFilter._done = true;

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

  ['custom-from', 'custom-to'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      customRangeFrom = new Date(document.getElementById('custom-from').value).getTime() || null;
      customRangeTo   = new Date(document.getElementById('custom-to').value).getTime()   || null;
      if (currentTimeFilter === 'custom') applyTimeFilter();
    });
  });
}

initTimeFilter();

if (typeof registerEgressViewInit === 'function') registerEgressViewInit('timeFilter', initTimeFilter);
if (typeof exposeEgressViewApi === 'function') {
  exposeEgressViewApi('applyTimeFilter', applyTimeFilter);
  exposeEgressViewApi('refreshCurrentTimeFilterView', refreshCurrentTimeFilterView);
}
