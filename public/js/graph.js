// ─── D3 Graph Setup ───────────────────────────────────────────────────────────
import { t, tVars } from './i18n.js?v=__ASSET_VERSION__';
import { _BASE, fmtBytes } from './utils.js?v=__ASSET_VERSION__';
import { getFilteredConnections, getTimeRange, currentTimeFilter, updateConnPanel } from './connections-panel.js?v=__ASSET_VERSION__';
import { statsMode, nlMode, logMode, currentView } from './view-tabs.js?v=__ASSET_VERSION__';
import { apiFetch, routerState } from './auth-socket.js?v=__ASSET_VERSION__';
import { flagEmoji, meshNodeId, normalizeGraphLinks, currentGraphRangeKey as _rangeKey, routerTargetsFromObservedBy } from './graph-helpers.js?v=__ASSET_VERSION__';
// Circular imports resolved at runtime (function-body-only calls):
import { updateStats } from './stats.js?v=__ASSET_VERSION__';
import { updateLogView } from './log.js?v=__ASSET_VERSION__';
import { nlRender } from './notif-log.js?v=__ASSET_VERSION__';
// Tooltip / side panel (P2-25 stage 2) and D3 renderer (stage 3).
// Re-exported below so existing importers keep using './graph.js'.
import { updateFilterTabs, updateSidePanel, updateSideHighlight, applyFilter, renderLogLoading } from './graph-panels.js?v=__ASSET_VERSION__';
export { showTooltip, moveTooltip, hideTooltip, setGraphDevicesDataRef } from './graph-panels.js?v=__ASSET_VERSION__';
import { initGraphRenderer, syncSimulation, drawLinks, drawNodes, applyGraphFilter, resetRenderer, simulation } from './graph-render.js?v=__ASSET_VERSION__';
export { simulation, applyGraphFilter } from './graph-render.js?v=__ASSET_VERSION__';

const svg = d3.select('#graph');
let width = 0, height = 0;

function resize({ refreshStats = true } = {}) {
  const el = document.getElementById('graph-container');
  width = el.clientWidth; height = el.clientHeight;
  svg.attr('width', width).attr('height', height);
  if (simulation && width && height) {
    simulation.force('x-center', d3.forceX(width/2).strength(0.04));
    simulation.force('y-split',  d3.forceY(d => d.type === 'org' ? height * 0.22 : height * 0.72).strength(d => d.type === 'org' ? 0.15 : 0.06));
    simulation.alpha(0.3).restart();
  }
  if (refreshStats && statsMode) updateStats();
}

const defs = svg.append('defs');
const glow = defs.append('filter').attr('id', 'glow');
glow.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
const feMerge = glow.append('feMerge');
feMerge.append('feMergeNode').attr('in', 'coloredBlur');
feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

['router','internet','client','meshnode','org'].forEach(id => {
  const color = id === 'router' ? '#f59e0b' : id === 'internet' ? '#6b7280' : id === 'meshnode' ? '#f97316' : id === 'org' ? '#7c3aed' : '#3b82f6';
  const refX  = id === 'org' ? 28 : 22;
  defs.append('marker').attr('id', `marker-${id}`)
    .attr('viewBox','0 -5 10 10').attr('refX', refX).attr('refY',0)
    .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill',color);
});

const g = svg.append('g');
// Expose zoomBehavior as a variable so external UI can drive it
const graphZoom = d3.zoom().scaleExtent([0.1, 3]).on('zoom', e => {
  g.attr('transform', e.transform);
  updateZoomUi(e.transform.k);
});
svg.call(graphZoom);

function updateZoomUi(k) {
  const pct = Math.round(k * 100);
  const slider = document.getElementById('zoom-slider');
  const label  = document.getElementById('zoom-pct');
  if (slider && document.activeElement !== slider) slider.value = pct;
  if (label) label.textContent = pct + '%';
}

function initGraph() {
  if (initGraph._done) return;
  initGraph._done = true;

  window.addEventListener('resize', resize);
  // Redraw on screen rotation too
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  // Re-fit when tab becomes visible (restores display after background-tab throttling)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resize();
      scheduleGraphAutoFit();
    }
  });

  document.getElementById('zoom-in').addEventListener('click', () => {
    svg.transition().duration(200).call(graphZoom.scaleBy, 1.3);
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    svg.transition().duration(200).call(graphZoom.scaleBy, 1 / 1.3);
  });
  document.getElementById('zoom-slider').addEventListener('input', e => {
    const k = parseFloat(e.target.value) / 100;
    const cur = d3.zoomTransform(svg.node());
    svg.call(graphZoom.transform, d3.zoomIdentity.translate(cur.x, cur.y).scale(k));
  });
  document.getElementById('zoom-fit').addEventListener('click', () => fitGraphToNodes());
}

initGraph();

let graphAutoFitTimers = [];

function fitGraphToNodes({ duration = 400, padding = 96, maxScale = 2.4 } = {}) {
  if (!nodes || !nodes.length) return;
  const xs = nodes.map(n => n.x).filter(Number.isFinite);
  const ys = nodes.map(n => n.y).filter(Number.isFinite);
  if (!xs.length) return;
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const wBox = Math.max(50, xMax - xMin);
  const hBox = Math.max(50, yMax - yMin);
  const sw = svg.node().clientWidth  || width;
  const sh = svg.node().clientHeight || height;
  if (!sw || !sh || sw <= padding || sh <= padding) return;
  const k = Math.min(maxScale, (sw - padding) / wBox, (sh - padding) / hBox);
  if (!Number.isFinite(k)) return;
  const kk = Math.max(0.1, k);
  const tx = sw / 2 - (xMin + wBox / 2) * kk;
  const ty = sh / 2 - (yMin + hBox / 2) * kk;
  svg.transition().duration(duration).ease(d3.easeCubicOut).call(
    graphZoom.transform, d3.zoomIdentity.translate(tx, ty).scale(kk)
  );
}

function scheduleGraphAutoFit({ delayedData = false } = {}) {
  graphAutoFitTimers.forEach(clearTimeout);
  graphAutoFitTimers = [];
  if (currentView !== 'graph') return;

  // The force simulation keeps settling after the data changes, so fit a few
  // times with soft transitions instead of snapping once to an early layout.
  // Longer period filters can load older data late, so keep following for a
  // few seconds after the first redraw.
  const delays = delayedData ? [160, 520, 1200, 2400, 4200] : [120, 360, 820];
  delays.forEach((delay, i) => {
    graphAutoFitTimers.push(setTimeout(() => {
      fitGraphToNodes({ duration: i === 0 ? 280 : 560, padding: 112, maxScale: 2.4 });
    }, delay));
  });
}
// The renderer owns the link/node SVG groups and the force simulation;
// node clicks come back through handleNodeClick (hoisted, defined below).
initGraphRenderer({ container: g, onNodeClick: (e, d) => handleNodeClick(e, d) });

let nodes = [], links = [];
let maxRate = 1024 * 512;
let selectedMac = null;
let selectedIp = null;
let lastMeshNodes = [];
let lastRouterIp = '';
let lastClients = [];
let lastMainMac = '';
let graphSummary = null;
let graphSummaryKey = null;
let graphSummaryInflight = { key: null, promise: null };

// Per-AiMesh-node identity colour
const MESH_COLORS = ['#f59e0b','#f97316','#14b8a6','#a78bfa','#fb7185'];
let meshColorMap = {};

// Accessors for graph-panels.js: the rate scale is shared with drawLinks,
// and meshColorMap is rebuilt on every graph update, so panels read through
// functions instead of holding stale references.
export function getMaxRate() { return maxRate; }
export function setMaxRate(v) { maxRate = v; }
export function getMeshColorMap() { return meshColorMap; }

function currentGraphRangeKey(from, to) {
  return _rangeKey(from, to, currentTimeFilter);
}

function activeRouterTopology() {
  const active = (routerState.routers || []).filter(router => router.enabled);
  if (active.length) {
    const nodesForRouters = active.map((router, index) => ({
      router,
      nodeId: index === 0 ? '__router__' : `__router_${router.id}__`,
    }));
    return {
      isMulti: active.length > 1,
      mainRouterLabel: active[0].displayName || (active[0].kind === 'cisco' ? 'Cisco IOS' : 'Yamaha RTX'),
      mainNodeId: '__router__',
      extraRouters: nodesForRouters.slice(1).map(item => ({ id: item.nodeId, label: item.router.displayName || item.router.id })),
      idToNode: new Map(nodesForRouters.map(item => [item.router.id.toLowerCase(), item.nodeId])),
      kindToNode: new Map(nodesForRouters.map(item => [item.router.kind, item.nodeId])),
    };
  }
  const hasYamaha = !!routerState.yamaha.enabled;
  const hasCisco  = !!routerState.cisco.enabled;
  const isMulti   = hasYamaha && hasCisco;
  return {
    hasYamaha,
    hasCisco,
    isMulti,
    mainRouterLabel: !hasYamaha && hasCisco ? 'Cisco IOS' : hasYamaha ? 'Yamaha RTX' : 'Router',
    extraRouters: isMulti ? [{ id: '__router_cisco__', label: 'Cisco IOS' }] : [],
    mainNodeId: '__router__',
  };
}

function graphSummaryNotice(show, summary) {
  const notice = document.getElementById('graph-summary-notice');
  if (!notice) return;
  notice.classList.toggle('is-visible', show);
  const truncated = document.getElementById('graph-truncated-notice');
  if (truncated && show) truncated.classList.remove('is-visible');
  if (show && summary) {
    notice.textContent = tVars('graph.summary', {
      total: Number(summary.total || 0).toLocaleString(),
      devices: (summary.byDevice || []).length.toLocaleString(),
      targets: (summary.byTarget || []).length.toLocaleString(),
    });
  }
}

function clearGraphSummary() {
  graphSummary = null;
  graphSummaryKey = null;
  graphSummaryNotice(false);
}

async function fetchGraphSummary(from, to) {
  const key = currentGraphRangeKey(from, to);
  if (graphSummary && graphSummaryKey === key) return graphSummary;
  if (graphSummaryInflight.key === key && graphSummaryInflight.promise) return graphSummaryInflight.promise;
  const params = new URLSearchParams();
  if (from != null) params.set('from', from);
  if (to != null) params.set('to', to);
  params.set('buckets', '60');
  graphSummaryInflight = {
    key,
    promise: (async () => {
      const res = await apiFetch(`${_BASE}/api/connections/summary?${params}`);
      if (!res.ok) throw new Error(`graph summary failed: ${res.status}`);
      graphSummary = await res.json();
      graphSummaryKey = key;
      graphSummaryNotice(true, graphSummary);
      return graphSummary;
    })(),
  };
  try {
    return await graphSummaryInflight.promise;
  } finally {
    if (graphSummaryInflight.key === key) graphSummaryInflight = { key: null, promise: null };
  }
}

function buildGraph(data, { resetPositions = false } = {}) {
  const clients = data.clients || [];
  lastClients = clients;
  const meshNodes = data.meshNodes || [];
  lastMeshNodes = meshNodes;
  lastRouterIp = data.routerIp;

  // Identify the main router MAC
  const mainNode = meshNodes.find(n => n.ip === data.routerIp);
  const mainMac = mainNode?.mac || '';
  lastMainMac = mainMac;

  // Satellite nodes (other than main router)
  const satellites = meshNodes.filter(n => n.ip !== data.routerIp);

  // Update colour mapping
  meshColorMap = {};
  meshNodes.forEach((n, i) => { meshColorMap[n.mac] = MESH_COLORS[i % MESH_COLORS.length]; });

  const extraRouters = data.extraRouters || [];

  const newNodes = [
    { id: '__internet__', label: 'Internet', type: 'internet', fixed: true },
    { id: '__router__', label: mainNode?.model || data.mainRouterLabel || 'Router', type: 'router', fixed: true, meshNode: mainNode, meshMac: mainMac },
    ...extraRouters.map(r => ({ id: r.id, label: r.label, type: 'router', fixed: true })),
    ...satellites.map(n => ({
      id: meshNodeId(n.mac), label: n.model || 'AiMesh',
      type: 'meshnode', fixed: false, meshNode: n, meshMac: n.mac,
    })),
    ...clients.map(c => ({ id: c.mac, label: c.name || c.ip, type: 'client', client: c }))
  ];

  const newLinks = [
    { source: '__internet__', target: '__router__', id: 'wan', rxRate: data.wanRx, txRate: data.wanTx, ltype: 'wan' },
    ...extraRouters.map(r => ({
      source: '__internet__', target: r.id, id: `wan_${r.id}`, rxRate: 0, txRate: 0, ltype: 'wan'
    })),
    ...satellites.map(n => ({
      source: '__router__', target: meshNodeId(n.mac),
      id: `mesh_${n.mac}`, rxRate: 0, txRate: 0, ltype: 'mesh'
    })),
    ...clients.flatMap(c => {
      // Multi-router: connect to each router the device was observed through
      if (c.routerTargets && c.routerTargets.length > 0) {
        return c.routerTargets.map((rt, i) => ({
          source: rt, target: c.mac,
          id: i === 0 ? c.mac : `${c.mac}_${rt}`,
          rxRate: c.rxRate, txRate: c.txRate, client: c, ltype: 'client',
        }));
      }
      const sat = satellites.find(n => n.mac === c.amesh_papMac);
      const source = sat ? meshNodeId(sat.mac) : '__router__';
      return [{ source, target: c.mac, id: c.mac, rxRate: c.rxRate, txRate: c.txRate, client: c, ltype: 'client' }];
    })
  ];

  // Stash org nodes/links before rebuilding (to preserve positions)
  const savedOrgNodes = resetPositions ? [] : nodes.filter(n => n.type === 'org');
  const newNodeIds = new Set(newNodes.map(n => n.id));
  const savedOrgLinks = resetPositions ? [] : normalizeGraphLinks(
    links.filter(l => l.ltype === 'dev-org'),
    [...newNodes, ...savedOrgNodes]
  ).filter(l => newNodeIds.has(l.source));

  const posMap = {};
  if (!resetPositions) nodes.forEach(n => posMap[n.id] = { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
  nodes = [...newNodes.map(n => posMap[n.id] ? { ...n, ...posMap[n.id] } : n), ...savedOrgNodes];
  links = normalizeGraphLinks([...newLinks, ...savedOrgLinks], nodes);

  updateSimulation(satellites);
  updateSidePanel(clients, data, meshNodes, mainMac);
  updateHeader(data);
  updateFilterTabs(meshNodes, mainMac, clients);
}

function updateSimulation(satellites) {
  if (!width || !height) resize({ refreshStats: false });
  if (!width || !height) return;
  links = normalizeGraphLinks(links, nodes);
  syncSimulation({ satellites, satelliteNodeId: sat => meshNodeId(sat.mac), width, height });
}

// Node click handler injected into graph-render.js: selection state and the
// cross-view refreshes live here, the D3 event wiring lives in the renderer.
function handleNodeClick(e, d) {
  selectedMac = d.id === selectedMac ? null : d.id;
  const selNode = nodes.find(n => n.id === selectedMac);
  selectedIp = selectedMac ? (selNode?.client?.ip || null) : null;
  updateSideHighlight();
  applyGraphFilter();
  if (statsMode) updateStats();
  updateConnPanel(selectedIp);
  if (logMode) {
    if (selectedMac) {
      const tb = document.getElementById('log-tbody');
      if (tb) renderLogLoading(tb);
    }
    updateLogView();
  }
  if (nlMode) nlRender();
}

function updateHeader(data) {
  document.getElementById('hdr-devices').textContent = (data.clients||[]).length;
  document.getElementById('hdr-wan-rx').textContent = fmtBytes(data.wanRx);
  document.getElementById('hdr-wan-tx').textContent = fmtBytes(data.wanTx);
  document.getElementById('last-update').textContent = t('last-update.prefix') + new Date(data.timestamp).toLocaleTimeString();
}

// Yamaha-only mode: build the graph treating src IPs as clients
function buildGraphFromConnections({ resetPositions = false } = {}) {
  const tr = typeof getTimeRange === 'function' ? getTimeRange() : { from: null, to: null };
  if (graphSummary && graphSummaryKey === currentGraphRangeKey(tr.from, tr.to)) {
    buildGraphFromSummary(graphSummary, { resetPositions });
    return;
  } else if (graphSummary) {
    clearGraphSummary();
  }
  // Do not early-return: still call buildGraph with empty arrays to clear the graph
  const filtered = getFilteredConnections();

  // Determine active routers for multi-router topology
  const topology = activeRouterTopology();
  const { isMulti } = topology;
  const srcRouterMap = isMulti ? new Map() : null; // ip → Set<routerNodeId>

  const srcCounts    = new Map();
  const srcMeta      = new Map(); // ip → {mac, vendor, dnsName, mdnsName}
  const srcFirstSeen = new Map(); // ip → min firstSeen
  for (const c of filtered) {
    srcCounts.set(c.src, (srcCounts.get(c.src) || 0) + 1);
    if (!srcMeta.has(c.src) && (c.srcMac || c.srcVendor || c.srcDnsName || c.srcMdnsName)) {
      srcMeta.set(c.src, {
        mac: c.srcMac, vendor: c.srcVendor, dnsName: c.srcDnsName, mdnsName: c.srcMdnsName,
      });
    }
    if (c.firstSeen) {
      const cur = srcFirstSeen.get(c.src);
      if (!cur || c.firstSeen < cur) srcFirstSeen.set(c.src, c.firstSeen);
    }
    if (isMulti) {
      if (!srcRouterMap.has(c.src)) srcRouterMap.set(c.src, new Set());
      for (const target of routerTargetsFromObservedBy(c.observedBy, c.source, isMulti, topology)) {
        srcRouterMap.get(c.src).add(target);
      }
    }
  }

  const syntheticClients = [...srcCounts.keys()].map(ip => {
    const m = srcMeta.get(ip) || {};
    const routerTargets = isMulti
      ? [...(srcRouterMap.get(ip) || ['__router__'])]
      : undefined;
    return {
      mac: m.mac || ip, ip, name: ip, type: '0',
      rxRate: 0, txRate: 0, rssi: null, amesh_papMac: null,
      vendor: m.vendor || '', dnsName: m.dnsName || null, mdnsName: m.mdnsName || null,
      deviceFirstSeen: srcFirstSeen.get(ip) || 0,
      ...(routerTargets ? { routerTargets } : {}),
    };
  });

  buildGraph({
    clients: syntheticClients, satellites: [], meshNodes: [],
    wanRx: 0, wanTx: 0, routerIp: null, timestamp: Date.now(),
    mainRouterLabel: topology.mainRouterLabel,
    extraRouters: topology.extraRouters,
  }, { resetPositions });
  updateOrgGraph({ resetPositions });
}

function buildGraphFromSummary(summary, { resetPositions = false } = {}) {
  const topology = activeRouterTopology();
  const deviceRows = (summary.byDevice || []).slice(0, 120);
  const targetRows = (summary.byTarget || []).slice(0, 160);
  const allowedDevices = new Set(deviceRows.map(r => r.src));
  const allowedTargets = new Set(targetRows.map(r => r.key || r.label));
  const syntheticClients = deviceRows.map(r => ({
    mac: r.src,
    ip: r.src,
    name: `${r.src} (${Number(r.count || 0).toLocaleString()})`,
    type: '0',
    rxRate: 0,
    txRate: 0,
    rssi: null,
    amesh_papMac: null,
    vendor: r.srcVendor || '',
    dnsName: null,
    mdnsName: null,
    deviceFirstSeen: r.firstSeen || 0,
    summarySessions: r.count || 0,
    ...(topology.isMulti ? {
      routerTargets: routerTargetsFromObservedBy(r.observedBy, r.sources || r.source, topology.isMulti, topology),
    } : {}),
  }));

  buildGraph({
    clients: syntheticClients, satellites: [], meshNodes: [],
    wanRx: 0, wanTx: 0, routerIp: null, timestamp: Date.now(),
    mainRouterLabel: topology.mainRouterLabel,
    extraRouters: topology.extraRouters,
  }, { resetPositions });

  const orgPosMap = {};
  if (!resetPositions) {
    nodes.forEach(n => { if (n.type === 'org') orgPosMap[n.id] = { x: n.x, y: n.y, vx: n.vx || 0, vy: n.vy || 0 }; });
  }
  nodes = nodes.filter(n => n.type !== 'org');
  links = links.filter(l => l.ltype !== 'dev-org');

  const cx = width / 2, cy = height / 2;
  const r0 = Math.min(cx, cy) * 0.75;
  const locations = new Map((summary.byLocation || []).map(l => [l.key || l.org, l]));
  const targetNodes = targetRows.map((r, i) => {
    const key = r.key || r.label;
    const id = `__org__:${key}`;
    const loc = locations.get(key) || {};
    const pos = orgPosMap[id];
    const angle = (2 * Math.PI * i) / Math.max(targetRows.length, 1);
    return {
      id,
      type: 'org',
      label: r.label || key,
      country: loc.country || '',
      flag: flagEmoji(loc.country),
      totalSessions: r.count || 0,
      summary: true,
      x: pos?.x ?? cx + r0 * Math.cos(angle),
      y: pos?.y ?? cy + r0 * Math.sin(angle),
      vx: pos?.vx || 0,
      vy: pos?.vy || 0,
    };
  });
  nodes = [...nodes, ...targetNodes];

  const clientByIp = {};
  nodes.forEach(n => { if (n.type === 'client' && n.client?.ip) clientByIp[n.client.ip] = n.id; });
  for (const e of summary.byEdge || []) {
    if (!allowedDevices.has(e.src) || !allowedTargets.has(e.key)) continue;
    const srcId = clientByIp[e.src];
    const targetId = `__org__:${e.key}`;
    if (srcId) links.push({
      source: srcId,
      target: targetId,
      id: `dev-org:${srcId}:${targetId}`,
      ltype: 'dev-org',
      sessionCount: e.count || 0,
      summary: true,
      rxRate: 0,
      txRate: 0,
    });
  }

  links = normalizeGraphLinks(links, nodes);
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('x-center', d3.forceX(cx).strength(0.04));
  simulation.force('y-split', d3.forceY(d => d.type === 'org' ? height * 0.22 : height * 0.72).strength(d => d.type === 'org' ? 0.15 : 0.06));
  simulation.alpha(0.35).restart();
  drawLinks();
  drawNodes();
  applyGraphFilter();
  graphSummaryNotice(true, summary);
  updateSidePanel(syntheticClients, {
    clients: syntheticClients,
    wanRx: 0,
    wanTx: 0,
    timestamp: Date.now(),
  }, [], '');
  document.getElementById('hdr-devices').textContent = deviceRows.length;
}

function updateOrgGraph({ resetPositions = false } = {}) {
  if (!simulation) return; // skip if simulation not yet initialised

  // Stash existing org nodes/links (preserve positions) then remove them
  const orgPosMap = {};
  if (!resetPositions) {
    nodes.forEach(n => { if (n.type === 'org') orgPosMap[n.id] = { x: n.x, y: n.y, vx: n.vx||0, vy: n.vy||0 }; });
  }
  nodes = nodes.filter(n => n.type !== 'org');
  links = links.filter(l => l.ltype !== 'dev-org');

  // Aggregate destinations per org (after period filter is applied)
  // Drop sessions without lat/lon → make this exactly match the map display
  const orgMap = new Map();
  for (const c of getFilteredConnections()) {
    if (c.lat == null || c.lon == null) continue;
    const key = c.org || c.dst;
    const label = c.org || (c.dstHost !== c.dst ? c.dstHost : c.dst);
    if (!orgMap.has(key)) orgMap.set(key, { id: `__org__:${key}`, type: 'org', label, flag: flagEmoji(c.country), country: c.country, srcs: new Map() });
    const e = orgMap.get(key);
    e.srcs.set(c.src, (e.srcs.get(c.src) || 0) + 1);
  }
  const orgList = [...orgMap.values()]
    .map(e => ({ ...e, totalSessions: [...e.srcs.values()].reduce((a,b)=>a+b,0) }))
    .sort((a,b) => b.totalSessions - a.totalSessions);

  // Add org nodes (prefer existing positions, otherwise evenly around the perimeter)
  const cx = width / 2, cy = height / 2;
  const r0 = Math.min(cx, cy) * 0.75;
  const newOrgNodes = orgList.map((o, i) => {
    const pos = orgPosMap[o.id];
    if (pos) return { ...o, ...pos };
    const angle = (2 * Math.PI * i) / Math.max(orgList.length, 1);
    return { ...o, x: cx + r0 * Math.cos(angle), y: cy + r0 * Math.sin(angle) };
  });
  nodes = [...nodes, ...newOrgNodes];

  // Device → org links (find device node by IP)
  const clientByIp = {};
  nodes.forEach(n => { if (n.type === 'client' && n.client?.ip) clientByIp[n.client.ip] = n.id; });
  for (const o of newOrgNodes) {
    for (const [srcIp, count] of o.srcs) {
      const srcId = clientByIp[srcIp];
      if (srcId) links.push({ source: srcId, target: o.id, id: `dev-org:${srcId}:${o.id}`, ltype: 'dev-org', sessionCount: count, rxRate: 0, txRate: 0 });
    }
  }

  links = normalizeGraphLinks(links, nodes);
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('x-center', d3.forceX(cx).strength(0.04));
  simulation.force('y-split',  d3.forceY(d => d.type === 'org' ? height * 0.22 : height * 0.72).strength(d => d.type === 'org' ? 0.15 : 0.06));
  simulation.alpha(0.3).restart();
  drawLinks();
  drawNodes();
  applyGraphFilter();
}

function showToast(message, durationMs = 5000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast multiline';
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => { el.classList.add('show'); }); });
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, durationMs);
}

function stopGraph() {
  resetRenderer();
  nodes = []; links = [];
  // Clear ASUS-derived caches too (prevents stale mesh-badge display)
  lastMeshNodes = [];
  lastClients = [];
  meshColorMap = {};
  document.getElementById('device-list').replaceChildren();
  document.getElementById('conn-panel').classList.remove('is-visible');
}

export { selectedMac, selectedIp, nodes, links, graphSummary, graphSummaryKey, buildGraph, buildGraphFromConnections, buildGraphFromSummary, updateOrgGraph, stopGraph, showToast, scheduleGraphAutoFit, fetchGraphSummary, clearGraphSummary, currentGraphRangeKey, updateSideHighlight, initGraph, lastMeshNodes, lastRouterIp, lastClients, lastMainMac, updateFilterTabs, applyFilter };
export function clearSelection() { selectedMac = null; selectedIp = null; }
export function setSelection(mac, ip) { selectedMac = mac; selectedIp = ip; }
export function resizeGraph(opts) { return resize(opts); }
