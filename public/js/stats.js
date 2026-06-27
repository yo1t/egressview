// ─── Statistics view ─────────────────────────────────────────────────────────
const STATS_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#a78bfa'];

// ── Stats page: Globe + Flat map ─────────────────────────────────────────────
var stGlobeSvg = null, stGlobeProj = null;
var stFlatSvg = null, stFlatProj = null, stFlatPath = null;
var stGlobeRotate = null; // initialised lazily from home country
var stColorScale = null;
var stSpin = true, stSpinTimer = null, stSpinResume = null;
var stFlatParticles = [], stFlatAnimId = null;
var stFlatInitScale = null, stFlatInitTranslate = null;
var stFlatZoom = 1, stFlatPanX = 0, stFlatPanY = 0;
var stSelIp = null; // active device filter (null = all)
var stMapPointOverride = null;
var stMapRenderSignature = null;
const ST_SPEEDS = [0.04, 0.08, 0.16, 0.32, 0.64];
var stSpeedIdx = 2; // default: ST_SPEEDS[2] = 0.16

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
  if (!stGlobeRotate) {
    const home = getHomeCoord();
    stGlobeRotate = [-home.lon, -home.lat * 0.4];
  }
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
  const pts = (stMapPointOverride || buildMapPoints()).filter(p => !stSelIp || p.srcs.has(stSelIp));
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
  stFlatInitScale = stFlatProj.scale();
  stFlatInitTranslate = stFlatProj.translate().slice();
  stFlatZoom = 1; stFlatPanX = 0; stFlatPanY = 0;
  stFlatPath = d3.geoPath(stFlatProj);
  stFlatSvg.append('path').attr('class','sf-sphere').datum({type:'Sphere'}).attr('fill','url(#sf-ocean)').attr('d', stFlatPath);
  stFlatSvg.append('path').attr('class','sf-grat').datum(d3.geoGraticule()()).attr('fill','none').attr('stroke','#2dd4bf').attr('stroke-width',0.3).attr('stroke-opacity',0.2).attr('d', stFlatPath);
  stFlatSvg.append('g').attr('class','sf-world').attr('filter','url(#sf-glow)').selectAll('path').data(worldGeo.features).join('path')
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
  const pts = (stMapPointOverride || buildMapPoints()).filter(p => !stSelIp || p.srcs.has(stSelIp));
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

function stUpdateFlatProj() {
  if (!stFlatSvg || !stFlatProj || stFlatInitScale == null) return;
  stFlatProj.scale(stFlatInitScale * stFlatZoom)
    .translate([stFlatInitTranslate[0] + stFlatPanX, stFlatInitTranslate[1] + stFlatPanY]);
  stFlatPath = d3.geoPath(stFlatProj);
  stFlatSvg.select('.sf-sphere').attr('d', stFlatPath);
  stFlatSvg.select('.sf-grat').attr('d', stFlatPath);
  stFlatSvg.select('.sf-world').selectAll('path').attr('d', stFlatPath);
  stRenderFlatData();
}

const SFM_PAN = 40, SFM_ZOOM_FACTOR = 1.3, SFM_MAX_ZOOM = 8, SFM_MIN_ZOOM = 0.4;

function stInitFlatControls() {
  const cell = document.getElementById('st-flat');
  if (!cell || document.getElementById('st-flat-controls')) return;
  const ctrl = document.createElement('div');
  ctrl.id = 'st-flat-controls';
  ctrl.className = 'flatmap-controls';
  ctrl.innerHTML =
    '<div class="fmc-zoom-row">' +
      '<button class="fmc-btn" id="sfm-zoom-in" title="拡大">＋</button>' +
      '<button class="fmc-btn" id="sfm-zoom-out" title="縮小">－</button>' +
    '</div>' +
    '<div class="fmc-dpad">' +
      '<span></span>' +
      '<button class="fmc-btn" id="sfm-up" title="上へ移動">↑</button>' +
      '<span></span>' +
      '<button class="fmc-btn" id="sfm-left" title="左へ移動">←</button>' +
      '<button class="fmc-btn fmc-btn-reset" id="sfm-reset" title="リセット">⊙</button>' +
      '<button class="fmc-btn" id="sfm-right" title="右へ移動">→</button>' +
      '<span></span>' +
      '<button class="fmc-btn" id="sfm-down" title="下へ移動">↓</button>' +
      '<span></span>' +
    '</div>';
  cell.appendChild(ctrl);
  document.getElementById('sfm-zoom-in').addEventListener('click', () => {
    stFlatZoom = Math.min(SFM_MAX_ZOOM, stFlatZoom * SFM_ZOOM_FACTOR); stUpdateFlatProj();
  });
  document.getElementById('sfm-zoom-out').addEventListener('click', () => {
    stFlatZoom = Math.max(SFM_MIN_ZOOM, stFlatZoom / SFM_ZOOM_FACTOR); stUpdateFlatProj();
  });
  document.getElementById('sfm-reset').addEventListener('click', () => {
    stFlatZoom = 1; stFlatPanX = 0; stFlatPanY = 0; stUpdateFlatProj();
  });
  document.getElementById('sfm-up').addEventListener('click',    () => { stFlatPanY += SFM_PAN; stUpdateFlatProj(); });
  document.getElementById('sfm-down').addEventListener('click',  () => { stFlatPanY -= SFM_PAN; stUpdateFlatProj(); });
  document.getElementById('sfm-left').addEventListener('click',  () => { stFlatPanX += SFM_PAN; stUpdateFlatProj(); });
  document.getElementById('sfm-right').addEventListener('click', () => { stFlatPanX -= SFM_PAN; stUpdateFlatProj(); });
}

function stStartSpin() {
  if (stSpinTimer) return;
  stSpinTimer = d3.timer(() => {
    if (!statsMode) return;
    if (stSpin && stGlobeProj) {
      stGlobeRotate[0] += ST_SPEEDS[stSpeedIdx];
      stGlobeProj.rotate(stGlobeRotate);
      stRenderGlobeData();
    }
  });
}

function stStopSpin() {
  if (stSpinTimer) { stSpinTimer.stop(); stSpinTimer = null; }
}

function stUpdateSpinUI() {
  const btn = document.getElementById('st-spin-toggle');
  if (btn) btn.textContent = stSpin ? '⏸' : '▶';
  const slower = document.getElementById('st-spin-slower');
  const faster = document.getElementById('st-spin-faster');
  if (slower) slower.disabled = stSpeedIdx === 0;
  if (faster) faster.disabled = stSpeedIdx === ST_SPEEDS.length - 1;
}

function stInitControls() {
  const cell = document.getElementById('st-globe');
  if (!cell) return;
  let ctrl = document.getElementById('st-globe-controls');
  if (!ctrl) {
    ctrl = document.createElement('div');
    ctrl.id = 'st-globe-controls';
    ctrl.className = 'globe-controls';
    ctrl.innerHTML =
      '<button class="globe-ctrl-btn" id="st-spin-slower" title="遅く">−</button>' +
      '<button class="globe-ctrl-btn" id="st-spin-toggle" title="停止 / 再生">⏸</button>' +
      '<button class="globe-ctrl-btn" id="st-spin-faster" title="速く">＋</button>';
    cell.appendChild(ctrl);
    document.getElementById('st-spin-toggle').addEventListener('click', () => {
      stSpin = !stSpin;
      if (stSpin && !stSpinTimer) stStartSpin();
      stUpdateSpinUI();
    });
    document.getElementById('st-spin-slower').addEventListener('click', () => {
      if (stSpeedIdx > 0) stSpeedIdx--;
      stUpdateSpinUI();
    });
    document.getElementById('st-spin-faster').addEventListener('click', () => {
      if (stSpeedIdx < ST_SPEEDS.length - 1) stSpeedIdx++;
      stUpdateSpinUI();
    });
  }
  stUpdateSpinUI();
}

function initStatsMaps(resetRotation) {
  if (resetRotation) stGlobeRotate = null; // force re-center on home country
  ensureWorldGeo(() => {
    if (!stRenderGlobeBase()) { requestAnimationFrame(initStatsMaps); return; }
    stRenderFlatBase();
    stRenderGlobeData();
    stRenderFlatData();
    stInitControls();
    stInitFlatControls();
    stStartSpin();
  });
}

function updateStatsMaps(selIp, mapPoints) {
  const nextSelIp = mapPoints ? null : (selIp ?? null);
  const renderSignature = mapPoints
    ? `summary|${selIp || ''}|${(mapPoints || []).map(p => [
        p.key || p.org || '',
        Number(p.lat).toFixed(3),
        Number(p.lon).toFixed(3),
        p.threat ? '1' : '0',
      ].join(':')).sort().join('|')}`
    : null;
  stMapPointOverride = mapPoints || null;
  stSelIp = nextSelIp;
  if (!stGlobeSvg) { initStatsMaps(); return; }
  if (renderSignature && stMapRenderSignature === renderSignature) {
    stStartSpin();
    return;
  }
  stMapRenderSignature = renderSignature;
  stRenderGlobeData();
  stRenderFlatData();
  stStartSpin();
}

let chartMode = 'stack'; // 'stack' | 'line'

function initStats() {
  if (initStats._done) return;
  initStats._done = true;

  window.addEventListener('resize', () => {
    if (typeof statsMode !== 'undefined' && statsMode && stGlobeSvg) {
      stRenderGlobeBase(); stRenderFlatBase();
      stRenderGlobeData(); stRenderFlatData();
    }
  });
  document.querySelectorAll('.chart-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chartMode = btn.dataset.mode;
      document.querySelectorAll('.chart-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (statsMode) updateStats();
    });
  });
}

initStats();

let statsSummaryGeneration = 0;
let statsSummaryCache = { key: null, at: 0, data: null };
let statsSummaryInflight = { key: null, promise: null };
let statsMapSummaryKey = null;
const STATS_SUMMARY_CACHE_MS = 60_000;

function getStatsSelection() {
  const sel = selectedMac;
  const selNode = sel ? nodes.find(n => n.id === sel) : null;
  return selNode?.client?.ip || null;
}

function setStatsEmpty(isEmpty, selIp) {
  const empty = document.getElementById('stats-empty');
  empty.style.display = isEmpty ? 'block' : 'none';
  document.getElementById('stats-charts').style.display = isEmpty ? 'none' : 'grid';
  if (isEmpty) updateMapCoverageNotice(null);
  if (isEmpty) updateStatsMaps(selIp, []);
}

function statsTargetRows(summary) {
  const rows = summary.byTarget && summary.byTarget.length
    ? summary.byTarget
    : (summary.byDst || []).map(r => ({
      key: r.org || r.dstHost || r.dst,
      label: r.org || r.dstHost || r.dst,
      count: r.count,
    }));
  return rows.map(r => ({
    key: r.key || r.label,
    label: r.label || r.key,
    count: r.count || 0,
  })).filter(r => r.key && r.count > 0);
}

function appSlicesFromSummary(groups, topN) {
  const unknownLabel = t('stats.app.unknown');
  const otherLabel = t('stats.legend.other');
  const counts = new Map();
  for (const g of groups || []) {
    const app = g.app || guessApp(g.dport, g.proto, g.dstHost) || unknownLabel;
    counts.set(app, (counts.get(app) || 0) + (g.count || 0));
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN).reduce((sum, [, count]) => sum + count, 0);
  if (rest > 0) top.push([otherLabel, rest]);
  return top;
}

function mapPointsFromSummary(summary) {
  return (summary.byLocation || [])
    .filter(r => r.lat != null && r.lon != null)
    .map(r => ({
      key: r.key || r.org,
      org: r.org || r.key,
      lat: Number(r.lat),
      lon: Number(r.lon),
      city: r.city || '',
      country: r.country || '',
      srcs: new Map(),
      maxTtl: r.maxTtl || 0,
      threat: false,
      totalSessions: r.totalSessions || 0,
      freshness: Math.max(0.15, Math.min(1.0, (r.maxTtl || 0) / 300)),
    }));
}

function updateMapCoverageNotice(coverage) {
  const el = document.getElementById('stats-map-coverage');
  if (!el) return;
  if (!coverage || !(coverage.totalSessions > 0)) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  const percent = Number(coverage.percent || 0).toFixed(1);
  el.textContent = tVars('stats.map.coverage', {
    shown: Number(coverage.shownGroups || 0).toLocaleString(),
    total: Number(coverage.totalGroups || 0).toLocaleString(),
    percent,
  });
  el.style.display = '';
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
  drawAppPieChart(null, appSlicesFromSummary(summary.appGroups, 8));
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
  const { from, to } = getTimeRange();
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
    if (data.serverTime) serverTimeOffset = data.serverTime - Date.now();
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
  renderStatsPiePreview(selIp);
  if (statsMapSummaryKey !== summaryKey) clearStatsMapsForPendingSummary(selIp);
  try {
    const summary = await fetchStatsSummary(selIp);
    if (generation !== statsSummaryGeneration || !statsMode) return;
    renderStatsSummary(summary, selIp);
    statsMapSummaryKey = summaryKey;
  } catch (e) {
    console.error('[stats] summary fetch failed:', e);
    if (generation !== statsSummaryGeneration || !statsMode) return;
    renderStatsFromLocalConnections(selIp);
    statsMapSummaryKey = summaryKey;
  }
}

// ─── App distribution pie chart (cyber style) ────────────────────────────────

const _PIE_CYBER_COLORS = [
  '#00e5ff', '#ff6b35', '#a855f7', '#22d3a3',
  '#f43f5e', '#fbbf24', '#38bdf8', '#ec4899',
];

function drawAppPieChart(conns, precomputedSlices) {
  const cell = document.getElementById('st-app-pie');
  if (!cell) return;
  const svg = d3.select('#st-app-pie-svg');
  svg.selectAll('*').remove();

  const w = cell.clientWidth;
  const h = cell.clientHeight;
  if (!w || !h) return;

  svg.attr('viewBox', `0 0 ${w} ${h}`);
  svg.append('rect').attr('width', w).attr('height', h).attr('fill', '#050a14');

  const slices  = precomputedSlices || _buildAppSlices(conns || [], 8, t('stats.app.unknown'), t('stats.legend.other'));
  const total   = slices.reduce((s, [, v]) => s + v, 0);
  const otherLbl = t('stats.legend.other');
  const isOther = (i) => i === slices.length - 1 && slices.length > 1 && slices[i][0] === otherLbl;
  const colorFor = (i) => isOther(i) ? '#374151' : _PIE_CYBER_COLORS[i % _PIE_CYBER_COLORS.length];

  const topPad   = 24;
  const legendRows = Math.ceil(Math.max(slices.length, 1) / 2);
  const legendH  = legendRows * 16 + 8;
  const pieAreaH = h - topPad - legendH;
  const r  = Math.max(8, Math.min(w / 2 - 16, pieAreaH / 2 - 12));
  const cx = w / 2;
  const cy = topPad + pieAreaH / 2;

  // ── Glow filter ────────────────────────────────────────────
  const defs = svg.append('defs');
  const filt = defs.append('filter')
    .attr('id', 'pglow').attr('x', '-60%').attr('y', '-60%')
    .attr('width', '220%').attr('height', '220%');
  filt.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '2.5').attr('result', 'blur');
  const fmerge = filt.append('feMerge');
  fmerge.append('feMergeNode').attr('in', 'blur');
  fmerge.append('feMergeNode').attr('in', 'SourceGraphic');

  // ── Radar grid ─────────────────────────────────────────────
  const radar = svg.append('g').attr('transform', `translate(${cx},${cy})`);
  [0.33, 0.66, 1.0].forEach(frac => {
    radar.append('circle').attr('r', r * frac)
      .attr('fill', 'none')
      .attr('stroke', frac < 1 ? 'rgba(0,229,255,0.07)' : 'rgba(0,229,255,0.18)')
      .attr('stroke-width', frac < 1 ? 0.5 : 1)
      .attr('stroke-dasharray', '3,6');
  });
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    radar.append('line')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', Math.cos(a) * r).attr('y2', Math.sin(a) * r)
      .attr('stroke', 'rgba(0,229,255,0.06)').attr('stroke-width', 0.5);
  }

  // ── Outer decorative ring ───────────────────────────────────
  svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', r + 8)
    .attr('fill', 'none')
    .attr('stroke', 'rgba(0,229,255,0.28)').attr('stroke-width', 1)
    .attr('stroke-dasharray', '4,7');

  // ── Scan line (CSS animated) ────────────────────────────────
  const scanG = svg.append('g')
    .attr('class', 'pie-scan')
    .style('transform-origin', `${cx}px ${cy}px`);
  scanG.append('line')
    .attr('x1', cx).attr('y1', cy)
    .attr('x2', cx + r * 0.98).attr('y2', cy)
    .attr('stroke', 'rgba(0,229,255,0.45)').attr('stroke-width', 1);
  scanG.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 2.5)
    .attr('fill', 'rgba(0,229,255,0.7)').attr('filter', 'url(#pglow)');

  if (total === 0) {
    svg.append('text').attr('x', cx).attr('y', cy + 4).attr('text-anchor', 'middle')
      .attr('fill', '#374151').attr('font-size', 11).text('—');
    return;
  }

  // ── Pie segments ───────────────────────────────────────────
  const pie  = d3.pie().value(d => d[1]).sort(null).padAngle(0.03);
  const arc  = d3.arc().innerRadius(r * 0.42).outerRadius(r);
  const arcH = d3.arc().innerRadius(r * 0.42).outerRadius(r + 7);

  const tip = svg.append('text')
    .attr('text-anchor', 'middle').attr('fill', '#00e5ff')
    .attr('font-size', 9.5).attr('pointer-events', 'none').style('display', 'none');

  const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);
  g.selectAll('path').data(pie(slices)).join('path')
    .attr('d', arc)
    .attr('fill', (_, i) => colorFor(i))
    .attr('fill-opacity', (_, i) => isOther(i) ? 0.45 : 0.82)
    .attr('stroke', (_, i) => colorFor(i))
    .attr('stroke-width', 0.8).attr('stroke-opacity', 0.5)
    .attr('filter', (_, i) => isOther(i) ? null : 'url(#pglow)')
    .on('mouseenter', function(ev, d) {
      d3.select(this).attr('d', arcH(d));
      const pct = ((d.data[1] / total) * 100).toFixed(1);
      tip.style('display', null)
        .attr('x', cx).attr('y', cy - r - 12)
        .text(`${d.data[0]}: ${d.data[1]} (${pct}%)`);
    })
    .on('mouseleave', function(ev, d) {
      d3.select(this).attr('d', arc(d));
      tip.style('display', 'none');
    });

  // ── Center label ───────────────────────────────────────────
  g.append('text').attr('text-anchor', 'middle').attr('dy', '-0.2em')
    .attr('fill', '#00e5ff').attr('font-size', Math.min(14, r * 0.25)).attr('font-weight', '600')
    .attr('filter', 'url(#pglow)').text(total.toLocaleString());
  g.append('text').attr('text-anchor', 'middle').attr('dy', '1.15em')
    .attr('fill', '#4a5568').attr('font-size', Math.min(8, r * 0.13))
    .text(t('stats.app.sessions'));

  // ── Legend (2 columns) ─────────────────────────────────────
  const legY0 = topPad + pieAreaH + 8;
  const colW  = w / 2;
  slices.forEach(([label, count], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = col * colW + 8, y = legY0 + row * 16 + 10;
    svg.append('rect').attr('x', x).attr('y', y - 7).attr('width', 8).attr('height', 8)
      .attr('rx', 2).attr('fill', colorFor(i))
      .attr('filter', isOther(i) ? null : 'url(#pglow)');
    const maxCh = Math.floor((colW - 22) / 5.5);
    const txt = label.length > maxCh ? label.slice(0, maxCh - 1) + '…' : label;
    svg.append('text').attr('x', x + 12).attr('y', y)
      .attr('fill', isOther(i) ? '#4a5568' : '#7c8aa3').attr('font-size', 9.5)
      .text(txt).append('title').text(`${label}: ${count}`);
  });
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

function chartInnerWidth(width, margin) {
  return Math.max(1, width - margin.left - margin.right);
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
  const iw = chartInnerWidth(w, margin);
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

if (typeof registerEgressViewInit === 'function') registerEgressViewInit('stats', initStats);
if (typeof exposeEgressViewApi === 'function') {
  exposeEgressViewApi('updateStats', updateStats);
  exposeEgressViewApi('initStatsMaps', initStatsMaps);
  exposeEgressViewApi('updateStatsMaps', updateStatsMaps);
}
