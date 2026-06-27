(function() {
// ─── D3 Graph Setup ───────────────────────────────────────────────────────────
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
const linkGroup = g.append('g');
const nodeGroup = g.append('g');

let simulation = null;
let nodes = [], links = [];
let maxRate = 1024 * 512;
let selectedMac = null;
let selectedIp = null;
let currentFilter = 'all';
let lastMeshNodes = [];
let lastRouterIp = '';
let lastSatellites = [];
let lastClients = [];
let lastMainMac = '';
let graphSummary = null;
let graphSummaryKey = null;
let graphSummaryInflight = { key: null, promise: null };

// Per-AiMesh-node identity colour
const MESH_COLORS = ['#f59e0b','#f97316','#14b8a6','#a78bfa','#fb7185'];
let meshColorMap = {};

function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(0x1F1E6 + code.charCodeAt(0) - 65, 0x1F1E6 + code.charCodeAt(1) - 65);
}

function meshNodeId(mac) { return `__node_${mac}__`; }

function linkEndpointId(endpoint) {
  return typeof endpoint === 'object' ? endpoint?.id : endpoint;
}

function normalizeGraphLinks(candidateLinks, candidateNodes) {
  const nodeIds = new Set(candidateNodes.map(n => n.id));
  return candidateLinks
    .map(l => ({
      ...l,
      source: linkEndpointId(l.source),
      target: linkEndpointId(l.target),
    }))
    .filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));
}

function currentGraphRangeKey(from, to) {
  if (typeof currentTimeFilter !== 'undefined' && currentTimeFilter) {
    if (currentTimeFilter === 'custom') return `custom:${from ?? ''}:${to ?? ''}`;
    if (currentTimeFilter === 'today' || currentTimeFilter === 'yesterday') {
      const day = from != null ? new Date(from).toISOString().slice(0, 10) : '';
      return `${currentTimeFilter}:${day}:${to ?? ''}`;
    }
    return `${currentTimeFilter}:open`;
  }
  return `${from ?? ''}:${to ?? ''}`;
}

function graphSummaryNotice(show, summary) {
  const notice = document.getElementById('graph-summary-notice');
  if (!notice) return;
  notice.style.display = show ? '' : 'none';
  const truncated = document.getElementById('graph-truncated-notice');
  if (truncated && show) truncated.style.display = 'none';
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
  lastSatellites = satellites;

  // Update colour mapping
  meshColorMap = {};
  meshNodes.forEach((n, i) => { meshColorMap[n.mac] = MESH_COLORS[i % MESH_COLORS.length]; });

  const newNodes = [
    { id: '__internet__', label: 'Internet', type: 'internet', fixed: true },
    { id: '__router__', label: mainNode?.model || 'Router', type: 'router', fixed: true, meshNode: mainNode, meshMac: mainMac },
    ...satellites.map(n => ({
      id: meshNodeId(n.mac), label: n.model || 'AiMesh',
      type: 'meshnode', fixed: false, meshNode: n, meshMac: n.mac,
    })),
    ...clients.map(c => ({ id: c.mac, label: c.name || c.ip, type: 'client', client: c }))
  ];

  const newLinks = [
    { source: '__internet__', target: '__router__', id: 'wan', rxRate: data.wanRx, txRate: data.wanTx, ltype: 'wan' },
    ...satellites.map(n => ({
      source: '__router__', target: meshNodeId(n.mac),
      id: `mesh_${n.mac}`, rxRate: 0, txRate: 0, ltype: 'mesh'
    })),
    ...clients.map(c => {
      const sat = satellites.find(n => n.mac === c.amesh_papMac);
      const source = sat ? meshNodeId(sat.mac) : '__router__';
      return { source, target: c.mac, id: c.mac, rxRate: c.rxRate, txRate: c.txRate, client: c, ltype: 'client' };
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
  const cx = width / 2, cy = height / 2;
  const internet = nodes.find(n => n.id === '__internet__');
  const router = nodes.find(n => n.id === '__router__');
  // Anchor router/internet nodes to the bottom
  if (internet) { internet.fx = cx - 160; internet.fy = height * 0.82; }
  if (router)   { router.fx  = cx;        router.fy  = height * 0.82; }

  // Initial placement of satellites at the bottom (when not yet positioned)
  satellites.forEach((sat, i) => {
    const sn = nodes.find(n => n.id === meshNodeId(sat.mac));
    if (sn && !sn.x) {
      const angle = Math.PI + (i - (satellites.length-1)/2) * 0.4;
      sn.x = cx + 160 * Math.cos(angle);
      sn.y = height * 0.82 + 80 * Math.sin(angle);
    }
  });

  // Target Y per node type
  const targetY = d => {
    if (d.type === 'org')    return height * 0.22; // destinations: top
    if (d.type === 'client') return height * 0.72; // clients: bottom
    return height * 0.78;                          // mesh etc.: lower
  };

  nodes.forEach((n, i) => {
    if (!Number.isFinite(n.x)) n.x = cx + Math.cos(i) * 40;
    if (!Number.isFinite(n.y)) n.y = cy + Math.sin(i) * 40;
    if (!Number.isFinite(n.vx)) n.vx = 0;
    if (!Number.isFinite(n.vy)) n.vy = 0;
  });
  const strengthY = d => {
    if (d.type === 'org')    return 0.15;
    if (d.type === 'client') return 0.06;
    return 0;
  };

  if (!simulation) {
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id)
        .distance(d => d.ltype === 'mesh' ? 180 : d.ltype === 'dev-org' ? 260 : 110)
        .strength(d => d.ltype === 'dev-org' ? 0.04 : 0.5))
      .force('charge', d3.forceManyBody().strength(-250))
      .force('collide', d3.forceCollide(38))
      .force('x-center', d3.forceX(cx).strength(0.04))
      .force('y-split',  d3.forceY(targetY).strength(strengthY))
      .on('tick', ticked);
  } else {
    simulation.nodes(nodes);
    simulation.force('link').links(links);
    simulation.force('x-center', d3.forceX(cx).strength(0.04));
    simulation.force('y-split',  d3.forceY(targetY).strength(strengthY));
    simulation.alpha(0.4).restart();
  }
  drawLinks(); drawNodes(); applyGraphFilter();
}

function drawLinks() {
  const link = linkGroup.selectAll('line').data(links, d => d.id);
  link.enter().append('line')
    .attr('marker-end', d => d.ltype === 'wan' ? 'url(#marker-router)' : d.ltype === 'mesh' ? 'url(#marker-meshnode)' : d.ltype === 'dev-org' ? 'url(#marker-org)' : 'url(#marker-client)')
    .merge(link)
    .attr('stroke-width', d => {
      if (d.ltype === 'mesh') return 2;
      if (d.ltype === 'dev-org') return Math.max(1, Math.min(d.summary ? 8 : 5, 1 + Math.log((d.sessionCount || 1) + 1)));
      const r = Math.max(d.rxRate || 0, d.txRate || 0);
      return Math.max(1, Math.min(8, 1 + r / (maxRate / 7)));
    })
    .attr('stroke', d => {
      if (d.ltype === 'mesh') return '#f97316';
      if (d.ltype === 'dev-org') return d.summary ? '#c4b5fd' : '#7c3aed';
      const r = Math.max(d.rxRate || 0, d.txRate || 0);
      return r > maxRate * 0.5 ? '#ef4444' : r > maxRate * 0.1 ? '#f59e0b' : r > 0 ? '#3b82f6' : '#1f2937';
    })
    .attr('stroke-dasharray', d => d.ltype === 'mesh' ? '6,3' : d.ltype === 'dev-org' ? (d.summary ? '2,5' : '4,3') : null)
    .attr('opacity', d => d.ltype === 'mesh' ? 0.6 : d.ltype === 'dev-org' ? (d.summary ? 0.72 : 0.45) : Math.max(d.rxRate || 0, d.txRate || 0) > 0 ? 0.9 : 0.35);
  link.exit().remove();
}

function drawNodes() {
  const node = nodeGroup.selectAll('g.node').data(nodes, d => d.id);
  const entered = node.enter().append('g').attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { if (!d.fixed) { d.fx = e.x; d.fy = e.y; } })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); if (!d.fixed) { d.fx = null; d.fy = null; } })
    )
    .on('click', (e, d) => {
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
          if (tb) tb.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)"><span class="spinner-xs"></span> ${t('data.loading') || '読み込み中'}</td></tr>`;
        }
        updateLogView();
      }
      if (typeof nlMode !== 'undefined' && nlMode) nlRender();
    })
    .on('mouseenter', showTooltip).on('mousemove', moveTooltip).on('mouseleave', hideTooltip);

  const orgR = d => 13 + Math.min(9, Math.log((d.totalSessions || 1) + 1) * 2.5);

  entered.append('circle')
    .attr('r', d => d.type === 'router' ? 22 : d.type === 'internet' ? 18 : d.type === 'meshnode' ? 20 : d.type === 'org' ? orgR(d) : 16)
    .attr('fill', d => {
      if (d.type === 'router') return '#f59e0b';
      if (d.type === 'internet') return '#374151';
      if (d.type === 'meshnode') return '#f97316';
      if (d.type === 'org') return d.summary ? '#1e1b4b' : '#3b0764';
      return nodeColor(d.client?.type || '0');
    })
    .attr('stroke', d => {
      if (d.type === 'router') return '#fbbf24';
      if (d.type === 'internet') return '#6b7280';
      if (d.type === 'meshnode') return '#fb923c';
      if (d.type === 'org') return d.summary ? '#c4b5fd' : '#7c3aed';
      return nodeColor(d.client?.type || '0');
    })
    .attr('stroke-width', d => d.summary ? 3 : 2).attr('fill-opacity', d => d.summary ? 0.72 : 0.85)
    .attr('filter', d => (d.type === 'router' || d.type === 'meshnode') ? 'url(#glow)' : null);

  entered.append('text')
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', d => d.type === 'router' || d.type === 'meshnode' ? '14px' : d.type === 'org' ? '13px' : '12px').attr('fill', '#fff')
    .text(d => d.type === 'router' ? '⬡' : d.type === 'meshnode' ? '⬡' : d.type === 'internet' ? '🌐' : d.type === 'org' ? (d.summary ? 'Σ' : (d.flag || '🌐')) : d.client?.summarySessions ? 'Σ' : isWiredType(d.client?.type) ? '🖥' : '📶');

  entered.append('text').attr('class', 'node-label')
    .attr('text-anchor', 'middle').attr('fill', '#e2e8f0')
    .attr('font-size', '10px').attr('font-family', 'SF Mono,Fira Code,monospace');

  nodeGroup.selectAll('g.node text.node-label').data(nodes, d => d.id)
    .attr('dy', d => (d.type === 'router' || d.type === 'meshnode') ? 32 : d.type === 'org' ? orgR(d) + 12 : 28)
    .text(d => {
      if (d.type === 'router') return d.label || 'Router';
      if (d.type === 'meshnode') return d.label || 'AiMesh';
      if (d.type === 'internet') return 'Internet';
      if (d.type === 'org') return d.label.length > 13 ? d.label.slice(0, 12) + '…' : d.label;
      return d.label.length > 16 ? d.label.slice(0, 15) + '…' : d.label;
    });
  node.exit().remove();
}

function ticked() {
  linkGroup.selectAll('line')
    .attr('x1', d => Number.isFinite(d.source.x) ? d.source.x : 0)
    .attr('y1', d => Number.isFinite(d.source.y) ? d.source.y : 0)
    .attr('x2', d => Number.isFinite(d.target.x) ? d.target.x : 0)
    .attr('y2', d => Number.isFinite(d.target.y) ? d.target.y : 0);
  nodeGroup.selectAll('g.node').attr('transform', d => `translate(${Number.isFinite(d.x) ? d.x : 0},${Number.isFinite(d.y) ? d.y : 0})`);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');
function showTooltip(e, d) {
  if (d.type === 'client' && d.client) {
    const c = d.client;
    const flag = flagEmoji(c.country);
    const proto = c.ipv6Addrs?.length ? '<span class="proto-badge proto-v6-grey">IPv6</span>' : '';
    tooltip.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">${esc(c.name || c.ip)}</div>
      ${proto}
      <div>${esc(c.ip)}</div>
      ${c.mac ? `<div style="font-size:10px;color:#9ca3af">${esc(c.mac)}</div>` : ''}
      ${c.vendor ? `<div style="font-size:10px;color:#9ca3af">${esc(c.vendor)}</div>` : ''}
      ${c.dnsName ? `<div style="font-size:10px">DNS: ${esc(c.dnsName)}</div>` : ''}
      ${c.mdnsName ? `<div style="font-size:10px">mDNS: ${esc(c.mdnsName)}</div>` : ''}
      ${c.summarySessions ? `<div style="margin-top:4px;color:#ddd6fe">summary: ${Number(c.summarySessions).toLocaleString()} sessions</div>` : ''}
      <div>↓ ${fmtBytes(c.rxRate)} ↑ ${fmtBytes(c.txRate)}</div>
      ${c.rssi != null ? `<div>RSSI: ${c.rssi} dBm</div>` : ''}`;
  } else if (d.type === 'org') {
    tooltip.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px">${esc(d.label)}</div>
      <div>${d.flag || ''} ${d.country ? esc(d.country) : ''}</div>
      <div>${Number(d.totalSessions || 0).toLocaleString()} sessions</div>
      ${d.summary ? `<div style="color:#ddd6fe">summary destination</div>` : ''}`;
  } else {
    tooltip.innerHTML = `<div>${esc(d.label || d.id)}</div>`;
  }
  tooltip.style.display = 'block';
  moveTooltip(e);
}
function moveTooltip(e) {
  const r = document.getElementById('graph-container').getBoundingClientRect();
  let x = e.clientX - r.left + 14, y = e.clientY - r.top - 10;
  if (x + 220 > r.width) x = e.clientX - r.left - 230;
  tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
}
function hideTooltip() { tooltip.style.display = 'none'; }

// ─── Side Panel ───────────────────────────────────────────────────────────────
function updateFilterTabs(meshNodes, mainMac, clients) {
  const tabs = document.getElementById('filter-tabs');
  const counts = { all: clients.length };
  meshNodes.forEach(n => {
    counts[n.mac] = clients.filter(c => c.amesh_papMac === n.mac || (!c.amesh_papMac && n.mac === mainMac)).length;
  });

  // Rebuild tabs
  tabs.innerHTML = '';
  const addTab = (filter, label) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (currentFilter === filter ? ' active' : '');
    btn.dataset.filter = filter;
    btn.textContent = `${label} (${counts[filter] ?? 0})`;
    btn.addEventListener('click', () => {
      currentFilter = filter;
      tabs.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
      applyFilter(clients);
    });
    tabs.appendChild(btn);
  };
  addTab('all', t('panel.tab.all'));
  meshNodes.forEach(n => addTab(n.mac, n.model || 'Node'));
}

function applyFilter(clients) {
  const list = document.getElementById('device-list');
  const searchRaw = (document.getElementById('device-search-input')?.value || '').trim().toLowerCase();
  list.querySelectorAll('.device-card').forEach(el => {
    const mac = el.dataset.mac;
    const c = clients.find(c => c.mac === mac);
    if (!c) return;
    const filterNode = lastMeshNodes.find(n => n.mac === currentFilter);
    const filterIsMain = filterNode?.ip === lastRouterIp;
    const tabMatch = currentFilter === 'all'
      || c.amesh_papMac === currentFilter
      || (filterIsMain && !c.amesh_papMac);
    const searchMatch = !searchRaw
      || (c.name || '').toLowerCase().includes(searchRaw)
      || (c.ip   || '').toLowerCase().includes(searchRaw)
      || (c.mac  || '').toLowerCase().includes(searchRaw);
    el.style.display = (tabMatch && searchMatch) ? '' : 'none';
  });
}

function updateSidePanel(clients, data, meshNodes, mainMac) {
  clients.forEach(c => { const r = Math.max(c.rxRate, c.txRate); if (r > maxRate) maxRate = r * 1.2; });
  const list = document.getElementById('device-list');
  const existing = {};
  list.querySelectorAll('.device-card').forEach(el => existing[el.dataset.mac] = el);
  const seen = new Set();

  clients.sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate)).forEach(c => {
    seen.add(c.mac);
    const papNode = meshNodes.find(n => n.mac === c.amesh_papMac);
    const nodeColor = meshColorMap[c.amesh_papMac] || '#6b7280';
    let card = existing[c.mac];
    if (!card) {
      card = document.createElement('div');
      card.className = `device-card ${nodeClass(c.type)}`;
      card.dataset.mac = c.mac;
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:4px">
          <div class="device-title" style="flex:1"></div>
          <span class="device-note-edit" title="${esc(t('note.edit.tip'))}">📝</span>
        </div>
        <div class="device-name empty"></div>
        <div class="device-meta empty"></div>
        <div class="device-resolved empty"></div>
        <div class="device-note empty"></div>
        <div class="device-traffic">
          <span class="traffic-pill rx">↓ <span class="rx-val"></span></span>
          <span class="traffic-pill tx">↑ <span class="tx-val"></span></span>
        </div>
        <div style="margin-top:6px">
          <div class="traffic-bar"><div class="traffic-bar-fill rx" style="width:0%"></div></div>
          <div class="traffic-bar" style="margin-top:3px"><div class="traffic-bar-fill tx" style="width:0%"></div></div>
        </div>`;
      card.addEventListener('click', () => {
        selectedMac = c.mac === selectedMac ? null : c.mac;
        selectedIp = selectedMac ? c.ip : null;
        updateSideHighlight();
        applyGraphFilter();
          if (statsMode) updateStats();
        updateConnPanel(selectedMac ? c.ip : null);
        if (logMode) {
          if (selectedMac) {
            const tb = document.getElementById('log-tbody');
            if (tb) tb.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)"><span class="spinner-xs"></span> ${t('data.loading') || '読み込み中'}</td></tr>`;
          }
          updateLogView();
        }
        if (typeof nlMode !== 'undefined' && nlMode) nlRender();
        if (devicesMode) {
          dvSelectedIp = selectedIp;
          renderDevicesTable();
        }
      });
      // Only the edit-icon click opens the edit modal
      card.querySelector('.device-note-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        openNoteModal(c.ip, c.mac, c.name || c.ip);
      });
      // Clicks on the note body do NOT trigger card selection (preserves scroll)
      card.querySelector('.device-note').addEventListener('click', (e) => e.stopPropagation());
      list.appendChild(card);
    }
    // Note display — prefer deviceId key (MCP-set notes) over IP/MAC composite
    const _noteDev = devicesData.find(d => d.ip === c.ip || (c.mac && c.mac !== c.ip && d.mac === c.mac));
    const noteText = lookupNote(c.ip, c.mac, _noteDev?.deviceId);
    const noteEl = card.querySelector('.device-note');
    if (noteEl) {
      if (noteText) {
        noteEl.textContent = noteText;
        noteEl.className = 'device-note';
      } else {
        noteEl.textContent = '';
        noteEl.className = 'device-note empty';
      }
    }
    // Title: IP / MAC (IP only when MAC is missing or equals IP)
    const macKnown = c.mac && c.mac !== c.ip;
    card.querySelector('.device-title').textContent = macKnown ? `${c.ip} / ${c.mac}` : c.ip;
    // Name (shown only when different from IP, dedupe)
    const nameEl = card.querySelector('.device-name');
    if (c.name && c.name !== c.ip) {
      nameEl.textContent = c.name;
      nameEl.className = 'device-name';
    } else {
      nameEl.textContent = '';
      nameEl.className = 'device-name empty';
    }
    // Meta: protocol badges + node badge + NEW badge + OUI vendor · connection type
    const metaEl = card.querySelector('.device-meta');
    const metaParts = [c.vendor, typeLabel(c.type)].filter(Boolean);
    let badgeHtml = '<span class="proto-badge proto-v4">IPv4</span>';
    if (c.ipv6Addrs && c.ipv6Addrs.length > 0) {
      badgeHtml += '<span class="proto-badge proto-v6-grey">IPv6</span>';
    }
    const nodeBadgeText = esc(papNode?.model?.replace(/RT-BE/,'') || 'Main');
    badgeHtml += `<span class="node-badge" style="background:${nodeColor}22;color:${nodeColor};border:1px solid ${nodeColor}44">${nodeBadgeText}</span>`;
    if (c.deviceFirstSeen && Date.now() - c.deviceFirstSeen < 24 * 60 * 60 * 1000) {
      badgeHtml += `<span class="new-badge">${t('device.new')}</span>`;
    }
    const metaText = metaParts.length ? ' ' + metaParts.map(esc).join(' · ') : '';
    metaEl.innerHTML = badgeHtml + metaText;
    metaEl.className = 'device-meta';
    // Name resolution: DNS / mDNS (omit if same as already-known name)
    const resolvedEl = card.querySelector('.device-resolved');
    const known = new Set([c.name, c.ip].filter(Boolean));
    const resolvedParts = [];
    if (c.dnsName  && !known.has(c.dnsName))  resolvedParts.push('DNS: '  + c.dnsName);
    if (c.mdnsName && !known.has(c.mdnsName) && c.mdnsName !== c.dnsName) resolvedParts.push('mDNS: ' + c.mdnsName);
    if (resolvedParts.length) {
      resolvedEl.textContent = resolvedParts.join(' · ');
      resolvedEl.className = 'device-resolved';
    } else {
      resolvedEl.textContent = '';
      resolvedEl.className = 'device-resolved empty';
    }
    card.querySelector('.rx-val').textContent = fmtBytes(c.rxRate);
    card.querySelector('.tx-val').textContent = fmtBytes(c.txRate);
    const rxPct = Math.min(100, (c.rxRate / maxRate) * 100);
    const txPct = Math.min(100, (c.txRate / maxRate) * 100);
    card.querySelectorAll('.traffic-bar-fill')[0].style.width = rxPct + '%';
    card.querySelectorAll('.traffic-bar-fill')[1].style.width = txPct + '%';
  });
  Object.keys(existing).forEach(mac => { if (!seen.has(mac)) existing[mac].remove(); });
  applyFilter(clients);

  const wMax = Math.max(maxRate, data.wanRx, data.wanTx, 1);
  document.getElementById('wan-rx-label').textContent = fmtBytes(data.wanRx);
  document.getElementById('wan-tx-label').textContent = fmtBytes(data.wanTx);
  document.getElementById('wan-rx-bar').style.width = Math.min(100, (data.wanRx / wMax) * 100) + '%';
  document.getElementById('wan-tx-bar').style.width = Math.min(100, (data.wanTx / wMax) * 100) + '%';
  updateSideHighlight();
}
function updateSideHighlight() {
  document.querySelectorAll('.device-card').forEach(el => el.classList.toggle('selected', el.dataset.mac === selectedMac));
}

function applyGraphFilter() {
  if (!simulation) return;

  const sel = selectedMac;
  const selNode = sel ? nodes.find(n => n.id === sel) : null;
  const searchRaw = (document.getElementById('device-search-input')?.value || '').trim().toLowerCase();

  // ── No filter ──────────────────────────────────────────────
  if (!sel && !searchRaw) {
    nodeGroup.selectAll('g.node').style('opacity', null).style('pointer-events', null);
    linkGroup.selectAll('line').style('opacity', null);
    return;
  }

  // Infrastructure nodes (always shown)
  const infraIds = new Set([
    '__internet__', '__router__',
    ...nodes.filter(n => n.type === 'meshnode').map(n => n.id),
  ]);

  // ── Client selected → selection filter has priority ────────
  if (sel && selNode && selNode.type === 'client') {
    const orgIds = orgIdsOf(new Set([sel]));
    const visibleIds = new Set([...infraIds, sel, ...orgIds]);

    nodeGroup.selectAll('g.node')
      .style('opacity', d => visibleIds.has(d.id) ? 1 : 0.07)
      .style('pointer-events', d => visibleIds.has(d.id) ? 'all' : 'none');

    linkGroup.selectAll('line').style('opacity', d => {
      const src = typeof d.source === 'object' ? d.source.id : d.source;
      const tgt = typeof d.target === 'object' ? d.target.id : d.target;
      if (d.ltype === 'wan')  return 0.4;
      if (d.ltype === 'mesh') return 0.3;
      if (src === sel || tgt === sel) return 0.9;
      return 0.04;
    });
    return;
  }

  // ── Search text present → search filter ──────────────────
  if (searchRaw) {
    const matchedIds = new Set(
      nodes
        .filter(n => {
          if (n.type !== 'client') return false;
          return (n.client?.name || '').toLowerCase().includes(searchRaw)
            || (n.client?.ip   || '').toLowerCase().includes(searchRaw)
            || (n.id           || '').toLowerCase().includes(searchRaw);
        })
        .map(n => n.id)
    );
    const orgIds = orgIdsOf(matchedIds);
    const visibleIds = new Set([...infraIds, ...matchedIds, ...orgIds]);

    nodeGroup.selectAll('g.node')
      .style('opacity', d => visibleIds.has(d.id) ? 1 : 0.07)
      .style('pointer-events', d => visibleIds.has(d.id) ? 'all' : 'none');

    linkGroup.selectAll('line').style('opacity', d => {
      const src = typeof d.source === 'object' ? d.source.id : d.source;
      const tgt = typeof d.target === 'object' ? d.target.id : d.target;
      if (d.ltype === 'wan')  return 0.4;
      if (d.ltype === 'mesh') return 0.3;
      if (matchedIds.has(src) || matchedIds.has(tgt)) return 0.8;
      return 0.04;
    });
    return;
  }

  // sel is set but not a client (router etc.) → no filter
  nodeGroup.selectAll('g.node').style('opacity', null).style('pointer-events', null);
  linkGroup.selectAll('line').style('opacity', null);
}

// Return org node IDs that the given set of client IDs connects to
function orgIdsOf(clientIdSet) {
  return new Set(
    links
      .filter(l => {
        const src = typeof l.source === 'object' ? l.source.id : l.source;
        return l.ltype === 'dev-org' && clientIdSet.has(src);
      })
      .map(l => typeof l.target === 'object' ? l.target.id : l.target)
  );
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
  }
  const syntheticClients = [...srcCounts.keys()].map(ip => {
    const m = srcMeta.get(ip) || {};
    return {
      mac: m.mac || ip, ip, name: ip, type: '0',
      rxRate: 0, txRate: 0, rssi: null, amesh_papMac: null,
      vendor: m.vendor || '', dnsName: m.dnsName || null, mdnsName: m.mdnsName || null,
      deviceFirstSeen: srcFirstSeen.get(ip) || 0,
    };
  });
  buildGraph({
    clients: syntheticClients, satellites: [], meshNodes: [],
    wanRx: 0, wanTx: 0, routerIp: null, timestamp: Date.now(),
  }, { resetPositions });
  updateOrgGraph({ resetPositions });
}

function buildGraphFromSummary(summary, { resetPositions = false } = {}) {
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
  }));

  buildGraph({
    clients: syntheticClients, satellites: [], meshNodes: [],
    wanRx: 0, wanTx: 0, routerIp: null, timestamp: Date.now(),
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
  el.className = 'toast';
  el.style.whiteSpace = 'pre-line';
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => { el.classList.add('show'); }); });
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, durationMs);
}

function stopGraph() {
  if (simulation) { simulation.stop(); simulation = null; }
  nodes = []; links = [];
  linkGroup.selectAll('*').remove();
  nodeGroup.selectAll('*').remove();
  // Clear ASUS-derived caches too (prevents stale mesh-badge display)
  lastMeshNodes = [];
  lastSatellites = [];
  lastClients = [];
  meshColorMap = {};
  document.getElementById('device-list').innerHTML = '';
  document.getElementById('conn-panel').style.display = 'none';
}

if (typeof registerEgressViewInit === 'function') registerEgressViewInit('graph', initGraph);
if (typeof exposeEgressViewApi === 'function') {
  exposeEgressViewApi('buildGraphFromConnections', buildGraphFromConnections);
  exposeEgressViewApi('buildGraph', buildGraph);
  exposeEgressViewApi('resizeGraph', resize);
  exposeEgressViewApi('scheduleGraphAutoFit', scheduleGraphAutoFit);
  exposeEgressViewApi('stopGraph', stopGraph);
}

// Expose public function API to window for classic-script callers
window.buildGraph = buildGraph;
window.buildGraphFromConnections = buildGraphFromConnections;
window.updateOrgGraph = updateOrgGraph;
window.stopGraph = stopGraph;
window.showToast = showToast;
window.scheduleGraphAutoFit = scheduleGraphAutoFit;
window.fetchGraphSummary = fetchGraphSummary;
window.clearGraphSummary = clearGraphSummary;
window.currentGraphRangeKey = currentGraphRangeKey;
window.updateSideHighlight = updateSideHighlight;

// Bridge mutable closure state as window properties so classic scripts can
// read/write them without breaking encapsulation of the IIFE closure.
Object.defineProperty(window, 'selectedMac',     { get: () => selectedMac,     set: v => { selectedMac     = v; }, configurable: true });
Object.defineProperty(window, 'selectedIp',      { get: () => selectedIp,      set: v => { selectedIp      = v; }, configurable: true });
Object.defineProperty(window, 'nodes',           { get: () => nodes,                                               configurable: true });
Object.defineProperty(window, 'graphSummary',    { get: () => graphSummary,                                        configurable: true });
Object.defineProperty(window, 'graphSummaryKey', { get: () => graphSummaryKey,                                     configurable: true });

})();
