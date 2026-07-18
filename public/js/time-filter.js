// ─── Time filter ──────────────────────────────────────────────────────────────
import { serverTimeOffset, setCustomRangeFrom, setCustomRangeTo, currentTimeFilter, setCurrentTimeFilter, getTimeRange, updateConnPanel } from './connections-panel.js?v=__ASSET_VERSION__';
import { statsMode, logMode, aiMode, refreshAiView } from './view-tabs.js?v=__ASSET_VERSION__';
import { nodes, selectedMac, buildGraphFromConnections, scheduleGraphAutoFit, fetchGraphSummary } from './graph.js?v=__ASSET_VERSION__';
import { updateStats } from './stats.js?v=__ASSET_VERSION__';
import { updateLogView } from './log.js?v=__ASSET_VERSION__';

let timeFilterGeneration = 0;

function renderTimeFilteredViews({ delayedData = false } = {}) {
  buildGraphFromConnections({ resetPositions: true });
  scheduleGraphAutoFit({ delayedData });
  if (statsMode)  updateStats();
  const selNode = nodes.find(n => n.id === selectedMac);
  updateConnPanel(selNode?.client?.ip || null);
}

async function applyTimeFilter() {
  const generation = ++timeFilterGeneration;
  const { from, to } = getTimeRange();
  const now = Date.now() + serverTimeOffset;
  const rangeMs = from == null ? Infinity : Math.max(0, (to ?? now) - from);
  const delayedData = rangeMs > 24 * 3600_000;

  // Log view fetches paged data independently, so start it without waiting for
  // the bounded graph summary.
  if (logMode) updateLogView();
  if (aiMode) return refreshAiView();

  try {
    await fetchGraphSummary(from, to);
  } catch (e) {
    console.error('[graph] summary fetch failed:', e);
  }
  if (generation !== timeFilterGeneration) return;
  renderTimeFilteredViews({ delayedData });
}

function refreshCurrentTimeFilterView() {
  return applyTimeFilter();
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
    setCurrentTimeFilter(e.target.value);
    const customWrap = document.getElementById('custom-range');
    if (currentTimeFilter === 'custom') {
      customWrap.classList.add('is-visible');
      // Initial values: past 1 hour
      const now = new Date(Date.now() + serverTimeOffset);
      const past = new Date(now.getTime() - 3600_000);
      const fromEl = document.getElementById('custom-from');
      const toEl   = document.getElementById('custom-to');
      if (!fromEl.value) fromEl.value = toLocalDatetimeStr(past);
      if (!toEl.value)   toEl.value   = toLocalDatetimeStr(now);
      setCustomRangeFrom(new Date(fromEl.value).getTime());
      setCustomRangeTo(new Date(toEl.value).getTime());
    } else {
      customWrap.classList.remove('is-visible');
    }
    applyTimeFilter();
  });

  ['custom-from', 'custom-to'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      setCustomRangeFrom(new Date(document.getElementById('custom-from').value).getTime() || null);
      setCustomRangeTo(new Date(document.getElementById('custom-to').value).getTime() || null);
      if (currentTimeFilter === 'custom') applyTimeFilter();
    });
  });
}

initTimeFilter();

export { applyTimeFilter, refreshCurrentTimeFilterView, initTimeFilter };
