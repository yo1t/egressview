// ─── Statistics view ─────────────────────────────────────────────────────────
const STATS_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#a78bfa'];

// ── Stats page: Globe + Flat map ─────────────────────────────────────────────
var stGlobeSvg = null, stGlobeProj = null;
var stFlatSvg = null, stFlatProj = null, stFlatPath = null;
var stGlobeRotate = [-139, -20];
var stColorScale = null;
var stSpin = true, stSpinTimer = null, stSpinResume = null;
var stFlatParticles = [], stFlatAnimId = null;
var stSelIp = null; // active device filter (null = all)

function stColor(d) {
  return d.threat ? '#ff2d55' : (stColorScale ? stColorScale(d.totalSessions) : '#9333ea');
}

function stRenderGlobeBase() {
  const cell = document.getElementById('st-globe');
  if (!cell) return false;
  const w = cell.clientWidth, h = cell.clientHeight;
  if (!w || !h) return false;
  stGlobeSvg = d3.select('#st-globe-svg').attr('viewBox', `0 0 ${w} ${h}`);
  stGlobeSvg.selectAll('*').remove();
  stGlobeSvg.append('defs').html(`
    <radialGradient id="sg-ocean" cx="42%" cy="38%" r="70%">
      <stop offset="0" stop-color="#0e2548"/><stop offset="60%" stop-color="#091530"/><stop offset="100%" stop-color="#04070f"/>
    </radialGradient>
    <radialGradient id="sg-atmo" cx="50%" cy="50%" r="50%">
      <stop offset="84%" stop-color="#38bdf8" stop-opacity="0"/><stop offset="98%" stop-color="#38bdf8" stop-opacity="0.4"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <filter id="sg-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="sg-glowS" x="-90%" y="-90%" width="280%" height="280%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  stGlobeProj = d3.geoOrthographic()
    .fitSize([Math.min(w, h) - 16, Math.min(w, h) - 16], { type: 'Sphere' })
    .translate([w / 2, h / 2]).rotate(stGlobeRotate);
  const R = stGlobeProj.scale();
  stGlobeSvg.append('circle').attr('cx', w/2).attr('cy', h/2).attr('r', R+6).attr('fill', 'url(#sg-atmo)');
  stGlobeSvg.append('path').attr('class', 'sg-ocean').datum({type:'Sphere'}).attr('fill', 'url(#sg-ocean)');
  stGlobeSvg.append('path').attr('class', 'sg-grat').datum(d3.geoGraticule()()).attr('fill','none').attr('stroke','#2dd4bf').attr('stroke-width',0.25).attr('stroke-opacity',0.13);
  stGlobeSvg.append('g').attr('class','sg-countries').attr('filter','url(#sg-glow)')
    .selectAll('path').data(worldGeo.features).join('path')
    .attr('fill','#0c2036').attr('fill-opacity',0.5).attr('stroke','#38bdf8').attr('stroke-width',0.5).attr('stroke-opacity',0.8);
  stGlobeSvg.append('path').attr('class','sg-rim').datum({type:'Sphere'}).attr('fill','none').attr('stroke','#38bdf8').attr('stroke-width',0.9).attr('stroke-opacity',0.5).attr('filter','url(#sg-glow)');
  stGlobeSvg.append('g').attr('class','sg-back').attr('filter','url(#sg-glow)');
  stGlobeSvg.append('g').attr('class','sg-arcs').attr('filter','url(#sg-glow)');
  stGlobeSvg.append('g').attr('class','sg-front').attr('filter','url(#sg-glow)');
  stGlobeSvg.append('g').attr('class','sg-pulses');
  stGlobeSvg.call(d3.drag()
    .on('start', () => { stSpin = false; if (stSpinResume) clearTimeout(stSpinResume); })
    .on('drag', ev => {
      stGlobeRotate[0] += ev.dx * 0.4;
      stGlobeRotate[1] = Math.max(-90, Math.min(90, stGlobeRotate[1] - ev.dy * 0.4));
      stGlobeProj.rotate(stGlobeRotate);
      stRenderGlobeData();
    })
    .on('end', () => { stSpinResume = setTimeout(() => { stSpin = true; }, 2500); }));
  return true;
}

function stRenderGlobeData() {
  if (!stGlobeSvg || !stGlobeProj) return;
  const p = d3.geoPath(stGlobeProj);
  stGlobeSvg.selectAll('.sg-ocean,.sg-grat,.sg-rim').attr('d', p);
  stGlobeSvg.select('.sg-countries').selectAll('path').attr('d', p);
  const home = getHomeCoord();
  const HLL = [home.lon, home.lat];
  const rot = stGlobeProj.rotate();
  const center = [-rot[0], -rot[1]];
  const near = ll => d3.geoDistance(ll, center) < Math.PI / 2 - 0.02;
  const pts = buildMapPoints().filter(p => !stSelIp || p.srcs.has(stSelIp));
  const maxS = Math.max(2, ...pts.map(d => d.totalSessions));
  stColorScale = d3.scaleSequentialLog().domain([1, maxS]).interpolator(d3.interpolate('#6d28d9', '#f97316'));
  const rScale = d => 2 + Math.sqrt(d.totalSessions / maxS) * 5;
  const items = pts.map(d => ({ d, n: near([d.lon, d.lat]), xy: stGlobeProj([d.lon, d.lat]) }));
  const hN = near(HLL), hxy = stGlobeProj(HLL);
  stGlobeSvg.select('.sg-arcs').selectAll('path').data(items).join('path')
    .attr('d', o => p({type:'LineString', coordinates:[HLL,[o.d.lon,o.d.lat]]}))
    .attr('fill','none').attr('stroke', o => stColor(o.d))
    .attr('stroke-width', o => o.d.threat ? 1.5 : 1).attr('stroke-linecap','round')
    .attr('stroke-opacity', o => o.n ? (o.d.threat ? 0.95 : 0.6) : 0.13);
  stGlobeSvg.select('.sg-back').selectAll('circle').data(items.filter(o => !o.n)).join('circle')
    .attr('cx', o => o.xy[0]).attr('cy', o => o.xy[1]).attr('r', o => rScale(o.d))
    .attr('fill', o => stColor(o.d)).attr('fill-opacity', 0.2);
  stGlobeSvg.select('.sg-front').selectAll('circle').data(items.filter(o => o.n)).join('circle')
    .attr('cx', o => o.xy[0]).attr('cy', o => o.xy[1]).attr('r', o => rScale(o.d))
    .attr('fill', o => stColor(o.d)).attr('fill-opacity', 0.95)
    .attr('filter', o => o.d.threat ? 'url(#sg-glowS)' : null);
  const pulses = stGlobeSvg.select('.sg-pulses');
  pulses.selectAll('*').remove();
  pulses.append('circle').attr('cx', hxy[0]).attr('cy', hxy[1]).attr('r', 4)
    .attr('fill','#ffe9a6').attr('fill-opacity', hN ? 1 : 0.25).attr('filter','url(#sg-glow)');
  items.filter(o => o.d.threat && o.n).forEach(o => {
    const ring = pulses.append('circle').attr('cx',o.xy[0]).attr('cy',o.xy[1]).attr('r',5)
      .attr('fill','none').attr('stroke','#ff2d55').attr('stroke-width',1.8);
    ring.append('animate').attr('attributeName','r').attr('values','5;20').attr('dur','1.4s').attr('repeatCount','indefinite');
    ring.append('animate').attr('attributeName','stroke-opacity').attr('values','0.9;0').attr('dur','1.4s').attr('repeatCount','indefinite');
  });
}

function stStopFlatAnim() {
  if (stFlatAnimId) { cancelAnimationFrame(stFlatAnimId); stFlatAnimId = null; }
  stFlatParticles = [];
}

function stStartFlatAnim() {
  if (stFlatAnimId) return;
  const tick = () => {
    stFlatParticles.forEach(p => {
      p.t = (p.t + p.speed) % 1.0;
      try {
        const pt = p.pathEl.getPointAtLength(p.t * p.totalLength);
        const col = d3.interpolate('#fffde7', p.orgColor)(Math.min(p.t * 2.8, 1));
        const opacity = p.t > 0.85 ? (1 - p.t) / 0.15 : 1;
        d3.select(p.dotEl).attr('cx', pt.x).attr('cy', pt.y).attr('fill', col).attr('opacity', opacity);
      } catch(_) {}
    });
    stFlatAnimId = requestAnimationFrame(tick);
  };
  stFlatAnimId = requestAnimationFrame(tick);
}

function stRenderFlatBase() {
  const cell = document.getElementById('st-flat');
  if (!cell) return false;
  const w = cell.clientWidth, h = cell.clientHeight;
  if (!w || !h) return false;
  stStopFlatAnim();
  stFlatSvg = d3.select('#st-flat-svg').attr('viewBox', `0 0 ${w} ${h}`);
  stFlatSvg.selectAll('*').remove();
  stFlatSvg.append('defs').html(`
    <radialGradient id="sf-ocean" cx="48%" cy="42%" r="80%"><stop offset="0" stop-color="#10254a"/><stop offset="55%" stop-color="#0a1730"/><stop offset="100%" stop-color="#050a14"/></radialGradient>
    <filter id="sf-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  stFlatSvg.append('defs').attr('id', 'sf-arc-grads');
  stFlatProj = d3.geoNaturalEarth1().rotate(getMapRotation()).fitSize([w, h], worldGeo);
  stFlatPath = d3.geoPath(stFlatProj);
  stFlatSvg.append('path').datum({type:'Sphere'}).attr('fill','url(#sf-ocean)').attr('d', stFlatPath);
  stFlatSvg.append('path').datum(d3.geoGraticule()()).attr('fill','none').attr('stroke','#2dd4bf').attr('stroke-width',0.3).attr('stroke-opacity',0.2).attr('d', stFlatPath);
  stFlatSvg.append('g').attr('filter','url(#sf-glow)').selectAll('path').data(worldGeo.features).join('path')
    .attr('fill','#0c2036').attr('stroke','#38bdf8').attr('stroke-width',0.5).attr('stroke-opacity',0.85).attr('d', stFlatPath);
  stFlatSvg.append('g').attr('class','sf-arcs').attr('filter','url(#sf-glow)');
  stFlatSvg.append('g').attr('class','sf-particles');
  stFlatSvg.append('g').attr('class','sf-dots').attr('filter','url(#sf-glow)');
  stFlatSvg.append('g').attr('class','sf-pulses');
  return true;
}

function stRenderFlatData() {
  if (!stFlatSvg || !stFlatProj) return;
  stStopFlatAnim();
  const home = getHomeCoord();
  const hxy = stFlatProj([home.lon, home.lat]);
  const pts = buildMapPoints().filter(p => !stSelIp || p.srcs.has(stSelIp));
  const maxS = Math.max(2, ...pts.map(d => d.totalSessions));
  const rScale = d => 4 + Math.sqrt(d.totalSessions / maxS) * 10;
  const ballisticD = (a, b) => {
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2;
    const lf = Math.min(Math.hypot(b[0]-a[0], b[1]-a[1]) * 0.38, 160);
    return `M${a[0]},${a[1]} Q${mx},${my-lf} ${b[0]},${b[1]}`;
  };
  const items = pts.map(d => ({ d, xy: stFlatProj([d.lon, d.lat]) || [-200,-200] }));

  // Per-arc linearGradient: bright cyan at home → org colour at destination
  const gradsDefs = stFlatSvg.select('#sf-arc-grads');
  gradsDefs.selectAll('*').remove();
  const arcGradId = d => 'sfg-' + (d.key||d.org||d.dst||'x').replace(/[^a-zA-Z0-9_-]/g,'_');
  items.forEach(o => {
    const endCol = stColor(o.d);
    const g = gradsDefs.append('linearGradient')
      .attr('id', arcGradId(o.d)).attr('gradientUnits','userSpaceOnUse')
      .attr('x1',hxy[0]).attr('y1',hxy[1]).attr('x2',o.xy[0]).attr('y2',o.xy[1]);
    g.append('stop').attr('offset','0').attr('stop-color','#bff7ff').attr('stop-opacity',0.95);
    g.append('stop').attr('offset','1').attr('stop-color',endCol).attr('stop-opacity',0.9);
  });

  // Gradient arcs
  stFlatSvg.select('.sf-arcs').selectAll('path').data(items, o => o.d.key).join('path')
    .attr('d', o => ballisticD(hxy, o.xy))
    .attr('fill','none')
    .attr('stroke', o => `url(#${arcGradId(o.d)})`)
    .attr('stroke-linecap','round')
    .attr('stroke-width', o => o.d.threat ? 2 : 1.2)
    .attr('stroke-opacity', o => o.d.threat ? 0.95 : (0.35 + 0.65 * (o.d.freshness ?? 1)));

  // Destination dots
  stFlatSvg.select('.sf-dots').selectAll('circle').data(items, o => o.d.key).join('circle')
    .attr('cx', o => o.xy[0]).attr('cy', o => o.xy[1]).attr('r', o => rScale(o.d))
    .attr('fill', o => stColor(o.d)).attr('fill-opacity', 0.9)
    .attr('filter', o => o.d.threat ? 'url(#sf-glow)' : null);

  // Threat pulse rings + home marker
  const pulses = stFlatSvg.select('.sf-pulses');
  pulses.selectAll('*').remove();
  pulses.append('circle').attr('cx',hxy[0]).attr('cy',hxy[1]).attr('r',4).attr('fill','#ffe9a6').attr('filter','url(#sf-glow)');
  items.filter(o => o.d.threat).forEach(o => {
    const ring = pulses.append('circle').attr('cx',o.xy[0]).attr('cy',o.xy[1]).attr('r',5).attr('fill','none').attr('stroke','#ff2d55').attr('stroke-width',1.8);
    ring.append('animate').attr('attributeName','r').attr('values','5;22').attr('dur','1.4s').attr('repeatCount','indefinite');
    ring.append('animate').attr('attributeName','stroke-opacity').attr('values','0.9;0').attr('dur','1.4s').attr('repeatCount','indefinite');
  });

  // Particles along arcs
  const particlesG = stFlatSvg.select('.sf-particles');
  particlesG.selectAll('*').remove();
  stFlatSvg.select('.sf-arcs').selectAll('path').each(function(o) {
    const pathEl = this;
    const totalLength = pathEl.getTotalLength();
    if (totalLength < 5) return;
    const pct = o.d.totalSessions / maxS;
    const speed = (0.0025 + pct * 0.0095) * (0.3 + 0.7 * (o.d.freshness ?? 1));
    const nParts = pct > 0.5 ? 4 : pct > 0.2 ? 3 : pct > 0.05 ? 2 : 1;
    const orgColor = stColor(o.d);
    for (let i = 0; i < nParts; i++) {
      const dotEl = particlesG.append('circle')
        .attr('r', 2.5).attr('fill', o.d.threat ? '#ff9bad' : '#ffffff').attr('opacity', 0).node();
      stFlatParticles.push({ pathEl, totalLength, t: i / nParts, speed, orgColor, dotEl });
    }
  });
  stStartFlatAnim();
}

function stStartSpin() {
  if (stSpinTimer) return;
  stSpinTimer = d3.timer(() => {
    if (!statsMode) return;
    if (stSpin && stGlobeProj) {
      stGlobeRotate[0] += 0.16;
      stGlobeProj.rotate(stGlobeRotate);
      stRenderGlobeData();
    }
  });
}

function stStopSpin() {
  if (stSpinTimer) { stSpinTimer.stop(); stSpinTimer = null; }
}

function initStatsMaps() {
  dashEnsureGeo(() => {
    if (!stRenderGlobeBase()) { requestAnimationFrame(initStatsMaps); return; }
    stRenderFlatBase();
    stRenderGlobeData();
    stRenderFlatData();
    stStartSpin();
  });
}

function updateStatsMaps(selIp) {
  stSelIp = selIp ?? null;
  if (!stGlobeSvg) { initStatsMaps(); return; }
  stRenderGlobeData();
  stRenderFlatData();
}

window.addEventListener('resize', () => {
  if (typeof statsMode !== 'undefined' && statsMode && stGlobeSvg) {
    stRenderGlobeBase(); stRenderFlatBase();
    stRenderGlobeData(); stRenderFlatData();
  }
});
let chartMode = 'stack'; // 'stack' | 'line'
document.querySelectorAll('.chart-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    chartMode = btn.dataset.mode;
    document.querySelectorAll('.chart-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    if (statsMode) updateStats();
  });
});

function updateStats() {
  if (!statsMode) return;
  const tlSvg  = document.getElementById('chart-timeline');
  const barSvg = document.getElementById('chart-bar');
  const subtitle = document.getElementById('stats-subtitle');
  const empty  = document.getElementById('stats-empty');

  // Selected node and period
  const sel = selectedMac;
  const selNode = sel ? nodes.find(n => n.id === sel) : null;
  const selIp   = selNode?.client?.ip || null;

  // Period label
  const filterLabel = document.querySelector('#time-filter-select option:checked')?.textContent || '';
  subtitle.textContent = selIp
    ? `${t('stats.subtitle.device')}: ${selIp} / ${t('stats.subtitle.period')}: ${filterLabel}`
    : `${t('stats.subtitle.all')} / ${t('stats.subtitle.period')}: ${filterLabel}`;

  // Period-filtered connection data
  let conns = getFilteredConnections();
  if (selIp) conns = conns.filter(c => c.src === selIp);

  if (!conns.length) {
    empty.style.display = 'block';
    document.getElementById('stats-charts').style.display = 'none';
    updateStatsMaps(selIp);
    return;
  }
  empty.style.display = 'none';
  document.getElementById('stats-charts').style.display = 'grid';

  // ── Total sessions per destination ──────────────────────
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const orgCounts = new Map();
  for (const c of conns) {
    const key = c.org || c.dstHost || c.dst;
    orgCounts.set(key, (orgCounts.get(key) || 0) + 1);
  }
  const sortedOrgs = [...orgCounts.entries()].sort((a,b) => b[1] - a[1]);
  // On mobile the screen is narrow, so split only the top 5 series; others go into "Other"
  const topN = isMobile ? 5 : 10;
  const topOrgs = sortedOrgs.slice(0, topN).map(e => e[0]);

  // Bar chart: top 15 on mobile, all on desktop (container scrolls)
  drawBarChart(isMobile ? sortedOrgs.slice(0, 15) : sortedOrgs);

  // ── Time-series buckets ──────────────────────────────
  // Decide bucket width from the period
  const tr = getTimeRange();
  const now = Date.now() + serverTimeOffset;
  const fromT = tr.from ?? Math.min(...conns.map(c => c.firstSeen || c.lastSeen || now));
  const toT   = tr.to   ?? now;
  const range = Math.max(toT - fromT, 60_000);
  const buckets = 60; // number of buckets
  const bw = range / buckets;

  // Aggregate per org × bucket
  const series = new Map(); // org -> Array<number>
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
  updateStatsMaps(selIp);
}

function drawTimeline(series, fromT, toT, buckets, bw, topOrgs) {
  const svg = d3.select('#chart-timeline');
  const node = svg.node();
  const w = node.clientWidth || 600;
  const h = node.clientHeight || 200;
  svg.attr('viewBox', `0 0 ${w} ${h}`);
  svg.selectAll('*').remove();
  const margin = { top: 8, right: 8, bottom: 22, left: 36 };
  const iw = w - margin.left - margin.right;
  const ih = h - margin.top - margin.bottom;
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  // Centre time of each bucket
  const times = d3.range(buckets).map(i => fromT + bw * (i + 0.5));
  const xScale = d3.scaleTime().domain([fromT, toT]).range([0, iw]);

  const labels = [...topOrgs, '__other__'];
  // Visible targets (drop all-zero series)
  const visibleLabels = labels.filter(l => {
    const arr = series.get(l);
    return arr && arr.some(v => v > 0);
  });
  const colorFor = (label) => label === '__other__'
    ? '#6b7280'
    : STATS_COLORS[labels.indexOf(label) % STATS_COLORS.length];

  if (chartMode === 'stack') {
    // ─── Stacked area chart ──────────────────────────
    // Reshape data into [{time, label1: v, label2: v, ...}] for d3.stack
    const stackData = times.map((t, i) => {
      const row = { time: t };
      for (const l of visibleLabels) row[l] = series.get(l)[i];
      return row;
    });
    const stack = d3.stack().keys(visibleLabels);
    const layers = stack(stackData);
    const maxY = d3.max(layers, layer => d3.max(layer, d => d[1])) || 1;
    const yScale = d3.scaleLinear().domain([0, maxY]).nice().range([ih, 0]);

    g.append('g').attr('class', 'stats-axis')
      .attr('transform', `translate(0,${ih})`)
      .call(d3.axisBottom(xScale).ticks(Math.min(8, Math.floor(iw / 80))).tickSizeOuter(0));
    g.append('g').attr('class', 'stats-axis')
      .call(d3.axisLeft(yScale).ticks(5).tickSizeOuter(0));

    const area = d3.area()
      .x((_, i) => xScale(times[i]))
      .y0(d => yScale(d[0]))
      .y1(d => yScale(d[1]))
      .curve(d3.curveMonotoneX);
    g.selectAll('path.stack-area').data(layers).join('path')
      .attr('class', 'stack-area')
      .attr('d', area)
      .attr('fill', d => colorFor(d.key))
      .attr('fill-opacity', 0.85)
      .attr('stroke', d => colorFor(d.key))
      .attr('stroke-width', 0.5);
  } else {
    // ─── Line chart ──────────────────────────────────
    const maxY = Math.max(1, ...visibleLabels.map(l => Math.max(...series.get(l))));
    const yScale = d3.scaleLinear().domain([0, maxY]).nice().range([ih, 0]);

    g.append('g').attr('class', 'stats-axis')
      .attr('transform', `translate(0,${ih})`)
      .call(d3.axisBottom(xScale).ticks(Math.min(8, Math.floor(iw / 80))).tickSizeOuter(0));
    g.append('g').attr('class', 'stats-axis')
      .call(d3.axisLeft(yScale).ticks(5).tickSizeOuter(0));

    const line = d3.line()
      .x((_, i) => xScale(times[i]))
      .y(d => yScale(d))
      .curve(d3.curveMonotoneX);
    for (const label of visibleLabels) {
      g.append('path').datum(series.get(label))
        .attr('class', 'stats-line')
        .attr('stroke', colorFor(label))
        .attr('d', line);
    }
  }

  // Legend
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const oldLegend = document.querySelector('#stats-timeline .stats-legend');
  if (oldLegend) oldLegend.remove();
  const legend = document.createElement('div');
  legend.className = 'stats-legend';
  for (const label of visibleLabels) {
    const item = document.createElement('div');
    item.className = 'stats-legend-item';
    const dot = document.createElement('div');
    dot.className = 'stats-legend-dot';
    dot.style.background = colorFor(label);
    item.appendChild(dot);
    const labelText = label === '__other__' ? t('stats.legend.other') : truncateLabel(label, isMobile ? 18 : 40);
    item.appendChild(document.createTextNode(labelText));
    item.title = label === '__other__' ? t('stats.legend.other') : label;
    legend.appendChild(item);
  }
  document.getElementById('stats-timeline').appendChild(legend);
}

function truncateLabel(s, maxLen) {
  s = String(s);
  return s.length > maxLen ? s.substring(0, maxLen - 1) + '…' : s;
}

function drawBarChart(orgs /* [[name, count], ...] */) {
  const svg = d3.select('#chart-bar');
  const node = svg.node();
  const w = node.clientWidth || 600;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const rowHeight = isMobile ? 18 : 22;
  const h = Math.max(60, orgs.length * rowHeight + 10);
  svg.attr('viewBox', `0 0 ${w} ${h}`)
     .attr('width', w).attr('height', h);
  svg.selectAll('*').remove();
  // Make the label area narrower on mobile
  const leftMargin = isMobile ? 110 : 180;
  const labelMax   = isMobile ? 14  : 32;
  const margin = { top: 4, right: 40, bottom: 6, left: leftMargin };
  const iw = w - margin.left - margin.right;
  const ih = h - margin.top - margin.bottom;
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

  const maxX = Math.max(1, ...orgs.map(d => d[1]));
  const xScale = d3.scaleLinear().domain([0, maxX]).range([0, iw]);
  const yScale = d3.scaleBand().domain(orgs.map(d => d[0])).range([0, ih]).padding(0.2);

  // Labels (truncate long names; show full name via title)
  g.append('g').attr('class', 'stats-axis').call(
    d3.axisLeft(yScale).tickSize(0).tickFormat(d => truncateLabel(d, labelMax))
  ).selectAll('text')
    .style('font-size', isMobile ? '9px' : '10px')
    .append('title').text(d => d);

  // Bars
  g.selectAll('rect').data(orgs).join('rect')
    .attr('class', 'stats-bar')
    .attr('x', 0)
    .attr('y', d => yScale(d[0]))
    .attr('height', yScale.bandwidth())
    .attr('width', d => xScale(d[1]))
    .attr('fill', (_, i) => STATS_COLORS[i % STATS_COLORS.length])
    .attr('rx', 2);

  // Value labels
  g.selectAll('text.bar-value').data(orgs).join('text')
    .attr('class', 'bar-value')
    .attr('x', d => xScale(d[1]) + 4)
    .attr('y', d => yScale(d[0]) + yScale.bandwidth() / 2 + 4)
    .attr('font-size', '10px')
    .attr('fill', '#e2e8f0')
    .text(d => d[1]);
}
