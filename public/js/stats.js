// ─── Statistics view ─────────────────────────────────────────────────────────
import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, _buildAppSlices, guessApp } from './utils.js?v=__ASSET_VERSION__';
import { getFilteredConnections, setFetching, serverTimeOffset, setServerTimeOffset, getTimeRange } from './connections-panel.js?v=__ASSET_VERSION__';
import { statsMode } from './view-tabs.js?v=__ASSET_VERSION__';
import { updateStatsMaps, scheduleStatsMapResize } from './stats-map.js?v=__ASSET_VERSION__';
export { initStatsMaps, updateStatsMaps, scheduleStatsMapResize, stStopSpin, stStopFlatAnim, resetStatsMaps } from './stats-map.js?v=__ASSET_VERSION__';
import { selectedMac, nodes, currentGraphRangeKey } from './graph.js?v=__ASSET_VERSION__';
import { apiFetch } from './auth-socket.js?v=__ASSET_VERSION__';
import { statsTargetRows, appSlicesFromSummary, mapPointsFromSummary } from './stats-helpers.js?v=__ASSET_VERSION__';
import { drawAppPieChart, drawTimeline, drawBarChart, getChartMode, initChartModeButtons } from './stats-charts.js?v=__ASSET_VERSION__';

function initStats() {
  if (initStats._done) return;
  initStats._done = true;

  window.addEventListener('resize', scheduleStatsMapResize);
  initChartModeButtons(() => { if (statsMode) updateStats(); });
}

initStats();

let statsSummaryGeneration = 0;
let statsSummaryCache = { key: null, at: 0, data: null };
let statsSummaryInflight = { key: null, promise: null };
let statsMapSummaryKey = null;
let statsRenderedSummary = { key: null, data: null, mode: null };
const STATS_SUMMARY_CACHE_MS = 60_000;
let statsSummaryRequestWindow = { key: null, from: null, to: null, at: 0 };

function getStatsSelection() {
  const sel = selectedMac;
  const selNode = sel ? nodes.find(n => n.id === sel) : null;
  return selNode?.client?.ip || null;
}

function setStatsEmpty(isEmpty, selIp) {
  const empty = document.getElementById('stats-empty');
  empty.classList.toggle('is-visible', isEmpty);
  document.getElementById('stats-charts').classList.toggle('is-hidden', isEmpty);
  if (isEmpty) updateMapCoverageNotice(null);
  if (isEmpty) updateStatsMaps(selIp, []);
}

function updateMapCoverageNotice(coverage) {
  const el = document.getElementById('stats-map-coverage');
  if (!el) return;
  if (!coverage || !(coverage.totalSessions > 0)) {
    el.classList.remove('is-visible');
    el.textContent = '';
    return;
  }
  const percent = Number(coverage.percent || 0).toFixed(1);
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  el.textContent = isMobile ? t('stats.map.coverage.mobile') : tVars('stats.map.coverage', {
    shown: Number(coverage.shownGroups || 0).toLocaleString(),
    total: Number(coverage.totalGroups || 0).toLocaleString(),
    percent,
  });
  el.classList.add('is-visible');
}

function renderStatsSummary(summary, selIp) {
  const targetRows = statsTargetRows(summary);
  if (!targetRows.length && !(summary.total > 0)) {
    setStatsEmpty(true, selIp);
    return;
  }
  setStatsEmpty(false, selIp);
  updateMapCoverageNotice(summary.mapCoverage);

  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const sortedTargets = targetRows.map(r => [r.key, r.count]);
  const topN = isMobile ? 5 : 10;
  const topTargets = sortedTargets.slice(0, topN).map(([key]) => key);
  drawBarChart(isMobile ? sortedTargets.slice(0, 15) : sortedTargets);

  const buckets = summary.buckets || 60;
  const fromT = summary.from ?? Date.now();
  const toT = summary.to ?? Date.now();
  const bw = Math.max(1, (Math.max(toT, fromT + 1) - fromT) / buckets);
  const series = new Map();
  for (const key of topTargets) series.set(key, new Array(buckets).fill(0));
  series.set('__other__', new Array(buckets).fill(0));
  for (const row of summary.timeline || []) {
    const bucket = Math.max(0, Math.min(buckets - 1, Number(row.bucket) || 0));
    const arr = series.get(row.key) || series.get('__other__');
    arr[bucket] += row.count || 0;
  }
  drawTimeline(series, fromT, toT, buckets, bw, topTargets);
  drawAppPieChart(null, appSlicesFromSummary(summary.appGroups, 8, {
    unknownLabel: t('stats.app.unknown'),
    otherLabel: t('stats.legend.other'),
    guessApp,
  }));
  updateStatsMaps(selIp, mapPointsFromSummary(summary));
}

function renderStatsFromLocalConnections(selIp) {
  updateMapCoverageNotice(null);
  // Period-filtered connection data
  let conns = getFilteredConnections();
  if (selIp) conns = conns.filter(c => c.src === selIp);

  if (!conns.length) {
    setStatsEmpty(true, selIp);
    return;
  }
  setStatsEmpty(false, selIp);

  // ── Total sessions per destination ──────────────────────
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const orgCounts = new Map();
  for (const c of conns) {
    const key = c.org || c.dstHost || c.dst;
    orgCounts.set(key, (orgCounts.get(key) || 0) + 1);
  }
  const sortedOrgs = [...orgCounts.entries()].sort((a,b) => b[1] - a[1]);
  const topN = isMobile ? 5 : 10;
  const topOrgs = sortedOrgs.slice(0, topN).map(e => e[0]);

  drawBarChart(isMobile ? sortedOrgs.slice(0, 15) : sortedOrgs);

  // ── Time-series buckets ──────────────────────────────
  const tr = getTimeRange();
  const now = Date.now() + serverTimeOffset;
  const fromT = tr.from ?? Math.min(...conns.map(c => c.firstSeen || c.lastSeen || now));
  const toT   = tr.to   ?? now;
  const range = Math.max(toT - fromT, 60_000);
  const buckets = 60;
  const bw = range / buckets;

  const series = new Map();
  for (const o of topOrgs) series.set(o, new Array(buckets).fill(0));
  series.set('__other__', new Array(buckets).fill(0));
  for (const c of conns) {
    const t = c.lastSeen || c.firstSeen || 0;
    const bi = Math.min(buckets - 1, Math.max(0, Math.floor((t - fromT) / bw)));
    const key = c.org || c.dstHost || c.dst;
    const arr = topOrgs.includes(key) ? series.get(key) : series.get('__other__');
    arr[bi]++;
  }

  drawTimeline(series, fromT, toT, buckets, bw, topOrgs);
  drawAppPieChart(conns);
  updateStatsMaps(selIp);
}

function renderStatsPiePreview(selIp) {
  let conns = getFilteredConnections();
  if (selIp) conns = conns.filter(c => c.src === selIp);
  drawAppPieChart(conns);
}

function clearStatsMapsForPendingSummary(selIp) {
  updateMapCoverageNotice(null);
  updateStatsMaps(selIp, []);
}

function buildStatsSummaryParams(selIp) {
  const { from, to } = getStableStatsSummaryRange();
  const params = new URLSearchParams();
  if (from != null) params.set('from', from);
  if (to != null) params.set('to', to);
  if (selIp) params.set('src', selIp);
  params.set('buckets', '60');
  return params;
}

function getStatsSummaryKey(selIp) {
  return buildStatsSummaryParams(selIp).toString();
}

function statsSummaryRangeKey(from, to) {
  if (typeof currentGraphRangeKey === 'function') return currentGraphRangeKey(from, to);
  return `${from ?? ''}:${to ?? ''}`;
}

function getStableStatsSummaryRange() {
  const { from, to } = getTimeRange();
  const key = statsSummaryRangeKey(from, to);
  const now = Date.now();
  if (
    statsSummaryRequestWindow.key === key &&
    now - statsSummaryRequestWindow.at < STATS_SUMMARY_CACHE_MS
  ) {
    return { from: statsSummaryRequestWindow.from, to: statsSummaryRequestWindow.to };
  }
  statsSummaryRequestWindow = { key, from, to, at: now };
  return { from, to };
}

async function fetchStatsSummary(selIp) {
  const params = buildStatsSummaryParams(selIp);
  const key = params.toString();
  const now = Date.now();
  if (statsSummaryCache.key === key && statsSummaryCache.data && now - statsSummaryCache.at < STATS_SUMMARY_CACHE_MS) {
    return statsSummaryCache.data;
  }
  if (statsSummaryInflight.key === key && statsSummaryInflight.promise) {
    return statsSummaryInflight.promise;
  }
  const showLoading = !(statsSummaryCache.key === key && statsSummaryCache.data);
  if (showLoading) setFetching(+1);
  statsSummaryInflight = {
    key,
    promise: (async () => {
    const res = await apiFetch(`${_BASE}/api/connections/summary?${params}`);
    if (!res.ok) throw new Error(`summary failed: ${res.status}`);
    const data = await res.json();
    if (data.serverTime) setServerTimeOffset(data.serverTime - Date.now());
    statsSummaryCache = { key, at: Date.now(), data };
    return data;
    })(),
  };
  try {
    return await statsSummaryInflight.promise;
  } finally {
    if (statsSummaryInflight.key === key) statsSummaryInflight = { key: null, promise: null };
    if (showLoading) setFetching(-1);
  }
}

async function updateStats() {
  if (!statsMode) return;
  const subtitle = document.getElementById('stats-subtitle');

  // Selected node and period
  const selIp = getStatsSelection();

  // Period label
  const filterLabel = document.querySelector('#time-filter-select option:checked')?.textContent || '';
  subtitle.textContent = selIp
    ? `${t('stats.subtitle.device')}: ${selIp} / ${t('stats.subtitle.period')}: ${filterLabel}`
    : `${t('stats.subtitle.all')} / ${t('stats.subtitle.period')}: ${filterLabel}`;

  const generation = ++statsSummaryGeneration;
  const summaryKey = getStatsSummaryKey(selIp);
  if (!(statsSummaryCache.key === summaryKey && statsSummaryCache.data)) {
    renderStatsPiePreview(selIp);
  }
  if (statsMapSummaryKey !== summaryKey) clearStatsMapsForPendingSummary(selIp);
  try {
    const summary = await fetchStatsSummary(selIp);
    if (generation !== statsSummaryGeneration || !statsMode) return;
    if (
      statsRenderedSummary.key === summaryKey &&
      statsRenderedSummary.data === summary &&
      statsRenderedSummary.mode === getChartMode()
    ) {
      statsMapSummaryKey = summaryKey;
      return;
    }
    renderStatsSummary(summary, selIp);
    statsMapSummaryKey = summaryKey;
    statsRenderedSummary = { key: summaryKey, data: summary, mode: getChartMode() };
  } catch (e) {
    console.error('[stats] summary fetch failed:', e);
    if (generation !== statsSummaryGeneration || !statsMode) return;
    renderStatsFromLocalConnections(selIp);
    statsMapSummaryKey = summaryKey;
  }
}

export { updateStats, initStats };
