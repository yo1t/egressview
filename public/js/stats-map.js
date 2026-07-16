// Globe and flat-map rendering for the statistics view (P2-28 stage 3,
// extracted from stats.js). Owns every piece of map state: projections,
// rotation, spin, particles, zoom/pan, resize bookkeeping, and the render
// signature that suppresses redundant redraws.
import { statsMode } from './view-tabs.js?v=__ASSET_VERSION__';
import { worldGeo, getHomeCoord, getMapRotation, buildMapPoints, ensureWorldGeo } from './map-common.js?v=__ASSET_VERSION__';

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
var stMapResizeTimer = null;
var stMapSize = { globeW: 0, globeH: 0, flatW: 0, flatH: 0 };
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

export function stStopFlatAnim() {
  if (stFlatAnimId) { cancelAnimationFrame(stFlatAnimId); stFlatAnimId = null; }
  stFlatParticles = [];
}

function stStartFlatAnim() {
  if (stFlatAnimId) return;
  const tick = () => {
    stFlatParticles.forEach(p => {
      p.phase = (p.phase + p.speed) % 1.0;
      try {
        const pt = p.pathEl.getPointAtLength(p.phase * p.totalLength);
        const col = d3.interpolate('#fffde7', p.orgColor)(Math.min(p.phase * 2.8, 1));
        const opacity = p.phase > 0.85 ? (1 - p.phase) / 0.15 : 1;
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
      stFlatParticles.push({ pathEl, totalLength, phase: i / nParts, speed, orgColor, dotEl });
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

function mapControlButton(id, title, label, className = 'fmc-btn') {
  const button = document.createElement('button');
  button.id = id;
  button.className = className;
  button.title = title;
  button.textContent = label;
  return button;
}

function stInitFlatControls() {
  const cell = document.getElementById('st-flat');
  if (!cell || document.getElementById('st-flat-controls')) return;
  const ctrl = document.createElement('div');
  ctrl.id = 'st-flat-controls';
  ctrl.className = 'flatmap-controls';
  const zoomRow = document.createElement('div');
  zoomRow.className = 'fmc-zoom-row';
  zoomRow.append(
    mapControlButton('sfm-zoom-in', '拡大', '＋'),
    mapControlButton('sfm-zoom-out', '縮小', '－'),
  );
  const dpad = document.createElement('div');
  dpad.className = 'fmc-dpad';
  const spacer = () => document.createElement('span');
  dpad.append(
    spacer(), mapControlButton('sfm-up', '上へ移動', '↑'), spacer(),
    mapControlButton('sfm-left', '左へ移動', '←'),
    mapControlButton('sfm-reset', 'リセット', '⊙', 'fmc-btn fmc-btn-reset'),
    mapControlButton('sfm-right', '右へ移動', '→'),
    spacer(), mapControlButton('sfm-down', '下へ移動', '↓'), spacer(),
  );
  ctrl.append(zoomRow, dpad);
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

export function stStopSpin() {
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
    ctrl.append(
      mapControlButton('st-spin-slower', '遅く', '−', 'globe-ctrl-btn'),
      mapControlButton('st-spin-toggle', '停止 / 再生', '⏸', 'globe-ctrl-btn'),
      mapControlButton('st-spin-faster', '速く', '＋', 'globe-ctrl-btn'),
    );
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

export function initStatsMaps(resetRotation) {
  if (resetRotation) stGlobeRotate = null; // force re-center on home country
  ensureWorldGeo(() => {
    if (!stRenderGlobeBase()) { requestAnimationFrame(initStatsMaps); return; }
    stRenderFlatBase();
    stRememberMapSize();
    stRenderGlobeData();
    stRenderFlatData();
    stInitControls();
    stInitFlatControls();
    stStartSpin();
  });
}

function stReadMapSize() {
  const globe = document.getElementById('st-globe');
  const flat = document.getElementById('st-flat');
  return {
    globeW: globe?.clientWidth || 0,
    globeH: globe?.clientHeight || 0,
    flatW: flat?.clientWidth || 0,
    flatH: flat?.clientHeight || 0,
  };
}

function stRememberMapSize() {
  stMapSize = stReadMapSize();
}

function stMapSizeChangedEnough(next) {
  return Math.abs(next.globeW - stMapSize.globeW) > 24 ||
    Math.abs(next.globeH - stMapSize.globeH) > 48 ||
    Math.abs(next.flatW - stMapSize.flatW) > 24 ||
    Math.abs(next.flatH - stMapSize.flatH) > 48;
}

export function scheduleStatsMapResize() {
  if (typeof statsMode === 'undefined' || !statsMode || !stGlobeSvg) return;
  const next = stReadMapSize();
  if (!next.globeW || !next.globeH || !next.flatW || !next.flatH) return;
  if (!stMapSizeChangedEnough(next)) return;
  if (stMapResizeTimer) clearTimeout(stMapResizeTimer);
  stMapResizeTimer = setTimeout(() => {
    stMapResizeTimer = null;
    const latest = stReadMapSize();
    if (!stMapSizeChangedEnough(latest)) return;
    stRenderGlobeBase();
    stRenderFlatBase();
    stRememberMapSize();
    stMapRenderSignature = null;
    stRenderGlobeData();
    stRenderFlatData();
  }, 250);
}

export function updateStatsMaps(selIp, mapPoints) {
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

export function resetStatsMaps() { stFlatSvg = null; stGlobeSvg = null; stGlobeRotate = null; }
