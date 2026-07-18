// D3 simulation and node/link rendering (P2-25 stage 3, extracted from graph.js).
// Owns the force simulation and the link/node SVG groups; graph.js keeps the
// data assembly (nodes/links arrays) and passes them in per call. The node
// click handler stays in graph.js (it drives selection and the other views)
// and is injected once via initGraphRenderer. Circular imports back into
// graph.js are function-body-only reads of live bindings.
import { showTooltip, moveTooltip, hideTooltip } from './graph-panels.js?v=__ASSET_VERSION__';
// Circular imports resolved at runtime (function-body-only calls):
import { nodes, links, selectedMac, getMaxRate } from './graph.js?v=__ASSET_VERSION__';
import { nodeColor, isWiredType } from './utils.js?v=__ASSET_VERSION__';

let linkGroup = null;
let nodeGroup = null;
let onNodeClick = () => {};

// Live binding: settings.js and graph.js read this to know whether a graph
// has been built yet.
export let simulation = null;

/** One-time wiring from graph.js: the parent <g> and the node click handler. */
export function initGraphRenderer({ container, onNodeClick: clickHandler }) {
  linkGroup = container.append('g');
  nodeGroup = container.append('g');
  onNodeClick = clickHandler;
}

/**
 * Create or update the force simulation for the current nodes/links and
 * redraw. Mirrors the layout rules the graph always had: routers anchored to
 * the bottom, org destinations pulled to the top, clients to the lower band.
 */
export function syncSimulation({ satellites, satelliteNodeId, width, height }) {
  const cx = width / 2, cy = height / 2;
  const internet = nodes.find(n => n.id === '__internet__');
  const router = nodes.find(n => n.id === '__router__');
  const extraRouterNodes = nodes.filter(n => n.type === 'router' && n.id !== '__router__');
  // Anchor router/internet nodes to the bottom
  if (extraRouterNodes.length > 0) {
    // Multi-router: internet center, routers spread left/right
    if (internet) { internet.fx = cx;        internet.fy = height * 0.82; }
    if (router)   { router.fx  = cx - 140;   router.fy  = height * 0.82; }
    extraRouterNodes.forEach((r, i) => {
      r.fx = cx + 140 * (i + 1);
      r.fy = height * 0.82;
    });
  } else {
    if (internet) { internet.fx = cx - 160; internet.fy = height * 0.82; }
    if (router)   { router.fx  = cx;        router.fy  = height * 0.82; }
  }

  // Initial placement of satellites at the bottom (when not yet positioned)
  satellites.forEach((sat, i) => {
    const sn = nodes.find(n => n.id === satelliteNodeId(sat));
    if (sn && !sn.x) {
      const angle = Math.PI + (i - (satellites.length - 1) / 2) * 0.4;
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

export function drawLinks() {
  const maxRate = getMaxRate();
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

export function drawNodes() {
  const node = nodeGroup.selectAll('g.node').data(nodes, d => d.id);
  const entered = node.enter().append('g').attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { if (!d.fixed) { d.fx = e.x; d.fy = e.y; } })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); if (!d.fixed) { d.fx = null; d.fy = null; } })
    )
    .on('click', (e, d) => onNodeClick(e, d))
    .on('mouseenter', showTooltip).on('mousemove', moveTooltip).on('mouseleave', hideTooltip);

  const orgR = d => 13 + Math.min(9, Math.log((d.totalSessions || 1) + 1) * 2.5);

  entered.append('circle');

  entered.append('text').attr('class', 'node-icon');

  const merged = entered.merge(node);
  merged.select('circle')
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

  merged.select('text.node-icon')
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

export function applyGraphFilter() {
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
    '__internet__',
    ...nodes.filter(n => n.type === 'router').map(n => n.id),
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

/** Stop the simulation and clear the drawn nodes/links (used by stopGraph). */
export function resetRenderer() {
  if (simulation) { simulation.stop(); simulation = null; }
  if (linkGroup) linkGroup.selectAll('*').remove();
  if (nodeGroup) nodeGroup.selectAll('*').remove();
}
