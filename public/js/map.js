// ─── World Map ────────────────────────────────────────────────────────────────
var worldGeo = null;
var mapSvg = null, mapG = null, mapProjection = null, mapPath = null;
var mapMode = false;
var currentMapK = 1;
var mapParticles = [];
var mapAnimId = null;
var homeCountry = 'JP'; // configurable

// Per-country: capital / centre coordinates
const COUNTRY_COORDS = {
  JP:{ lat:35.68, lon:139.69 }, US:{ lat:38.89, lon:-77.04 }, CA:{ lat:45.42, lon:-75.69 },
  GB:{ lat:51.50, lon:-0.12  }, DE:{ lat:52.52, lon:13.40  }, FR:{ lat:48.86, lon:2.35   },
  IT:{ lat:41.90, lon:12.50  }, ES:{ lat:40.42, lon:-3.70  }, NL:{ lat:52.09, lon:5.10   },
  SE:{ lat:59.33, lon:18.07  }, CH:{ lat:46.95, lon:7.45   }, NO:{ lat:59.91, lon:10.75  },
  AU:{ lat:-35.28,lon:149.13 }, NZ:{ lat:-41.29,lon:174.78 }, CN:{ lat:39.91, lon:116.39 },
  KR:{ lat:37.57, lon:126.98 }, TW:{ lat:25.04, lon:121.56 }, HK:{ lat:22.32, lon:114.17 },
  SG:{ lat:1.35,  lon:103.82 }, IN:{ lat:28.61, lon:77.21  }, BR:{ lat:-15.79,lon:-47.88 },
  RU:{ lat:55.75, lon:37.62  },
};

function getHomeCoord() {
  return COUNTRY_COORDS[homeCountry] || COUNTRY_COORDS['JP'];
}
// Japan → centred on Japan; otherwise → centred on Greenwich
function getMapRotation() {
  return homeCountry === 'JP' ? [-140, 0] : [0, 0];
}

const mapTooltipEl = document.getElementById('map-tooltip');

function showMapTooltip(event, d) {
  const flag = d.country && d.country.length === 2
    ? String.fromCodePoint(0x1F1E0 + d.country.charCodeAt(0) - 65, 0x1F1E0 + d.country.charCodeAt(1) - 65)
    : '';
  const stateColor = d.freshness >= 0.8 ? '#10b981' : d.freshness >= 0.4 ? '#f59e0b' : '#ef4444';
  const stateLabel = d.freshness >= 0.8 ? t('maptt.state.active')
                   : d.freshness >= 0.4 ? t('maptt.state.idle')
                   : t('maptt.state.timeout');
  mapTooltipEl.innerHTML = `
    <div class="map-tooltip-name">${esc(d.org || d.key)}</div>
    <div class="map-tooltip-row"><span class="map-tooltip-key">${esc(t('maptt.place'))}</span><span class="map-tooltip-val">${esc([d.city, flag].filter(Boolean).join(' '))}</span></div>
    <div class="map-tooltip-row"><span class="map-tooltip-key">${esc(t('maptt.session'))}</span><span class="map-tooltip-val">${esc(d.totalSessions)}</span></div>
    <div class="map-tooltip-row"><span class="map-tooltip-key">${esc(t('maptt.src'))}</span><span class="map-tooltip-val">${esc(d.srcs.size)} ${esc(t('maptt.devices'))}</span></div>
    <div class="map-tooltip-row"><span class="map-tooltip-key">${esc(t('maptt.state'))}</span><span class="map-tooltip-val" style="color:${stateColor}">${stateLabel} (${esc(t('maptt.ttl.remain'))} ${esc(d.maxTtl)}s)</span></div>`;
  mapTooltipEl.style.display = 'block';
  moveMapTooltip(event);
}
function moveMapTooltip(event) {
  const r = document.getElementById('map-container').getBoundingClientRect();
  let x = event.clientX - r.left + 14, y = event.clientY - r.top - 10;
  if (x + 230 > r.width) x = event.clientX - r.left - 240;
  mapTooltipEl.style.left = x + 'px'; mapTooltipEl.style.top = y + 'px';
}
function hideMapTooltip() { mapTooltipEl.style.display = 'none'; }

function buildMapPoints() {
  const orgMap = new Map();
  for (const c of getFilteredConnections()) {
    if (c.lat == null || c.lon == null) continue;
    const key = c.org || c.dst;
    if (!orgMap.has(key)) orgMap.set(key, {
      key, org: c.org || c.dstHost || c.dst,
      lat: c.lat, lon: c.lon, city: c.city || '', country: c.country || '',
      srcs: new Map(), maxTtl: 0,
    });
    const e = orgMap.get(key);
    e.srcs.set(c.src, (e.srcs.get(c.src) || 0) + 1);
    // Adopt lat/lon from the session with the highest (most stable) TTL → prevents flicker between polls
    if ((c.ttl || 0) > e.maxTtl) {
      e.maxTtl = c.ttl || 0;
      e.lat = c.lat; e.lon = c.lon;
      e.city = c.city || e.city;
      e.country = c.country || e.country;
    }
  }
  return [...orgMap.values()].map(e => ({
    ...e,
    totalSessions: [...e.srcs.values()].reduce((a, b) => a + b, 0),
    // TTL ≥300s → fully active (1.0); below that, linear fade; floor at 0.15
    freshness: Math.max(0.15, Math.min(1.0, (e.maxTtl || 0) / 300)),
  }));
}

async function initWorldMap() {
  if (worldGeo) { renderWorldMap(); return; }
  const mc = document.getElementById('map-container');
  const loadMsg = d3.select(mc).append('div')
    .style('position','absolute').style('inset','0').style('display','flex')
    .style('align-items','center').style('justify-content','center')
    .style('color','#4b6a8a').style('font-size','13px').text('🌐 地図データを読み込み中…');
  try {
    const topo = await d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    worldGeo = topojson.feature(topo, topo.objects.countries);
    loadMsg.remove();
    renderWorldMap();
  } catch(err) {
    loadMsg.text('地図データの読み込みに失敗しました'); console.error('[map]', err);
  }
}

function renderWorldMap() {
  const mc = document.getElementById('map-container');
  const w = mc.clientWidth, h = mc.clientHeight;
  // If layout is not done and size is 0, retry on the next frame
  if (w === 0 || h === 0) {
    requestAnimationFrame(renderWorldMap);
    return;
  }
  // Reset zoom factor (so we do not redraw at the previous zoom value)
  currentMapK = 1;
  mapProjection = d3.geoNaturalEarth1().rotate(getMapRotation()).fitSize([w, h], worldGeo);
  mapPath = d3.geoPath(mapProjection);

  mapSvg = d3.select('#world-map').attr('viewBox', `0 0 ${w} ${h}`);
  mapSvg.selectAll('*').remove();
  mapG = mapSvg.append('g');

  // Ocean (sphere)
  mapG.append('path').datum({type:'Sphere'}).attr('class','map-sphere').attr('d', mapPath);
  // Graticule
  mapG.append('path').datum(d3.geoGraticule()()).attr('class','map-graticule').attr('d', mapPath);
  // Country borders
  mapG.append('g').selectAll('path')
    .data(worldGeo.features).join('path').attr('class','map-country').attr('d', mapPath);
  // Ballistic-arc layer (bottom-most)
  mapG.append('g').attr('class','map-arcs');
  // Particle layer
  mapG.append('g').attr('class','map-particles');
  // Dot layer (above arcs and particles)
  mapG.append('g').attr('class','map-dots');

  // Home router marker (coordinates of the configured country)
  const { lat: hLat, lon: hLon } = getHomeCoord();
  const homeXY = mapProjection([hLon, hLat]);
  const homeG = mapG.append('g').attr('class','map-home')
    .attr('transform', `translate(${homeXY[0]},${homeXY[1]})`);
  homeG.append('circle').attr('class','home-ring').attr('data-base-r', 10)
    .attr('r', 10).attr('fill','#f59e0b').attr('fill-opacity',0.25)
    .attr('stroke','#f59e0b').attr('stroke-width',1.5);
  homeG.append('circle').attr('class','home-dot').attr('data-base-r', 5)
    .attr('r', 5).attr('fill','#f59e0b');
  homeG.append('text').attr('class','home-label').text('🏠')
    .attr('text-anchor','middle').attr('dy','-12px').attr('font-size','11px');

  // Zoom — dots/arcs/particles/markers are inverse-scaled so their on-screen size stays constant
  mapSvg.call(
    d3.zoom().scaleExtent([0.8, 20]).on('zoom', e => {
      mapG.attr('transform', e.transform);
      currentMapK = e.transform.k;
      mapSvg.selectAll('circle.map-dot').attr('r', function() {
        return parseFloat(this.getAttribute('data-base-r') || 5) / currentMapK;
      });
      mapSvg.selectAll('path.map-arc').attr('stroke-width', 0.5 / currentMapK);
      mapSvg.selectAll('circle.map-particle').attr('r', 2.5 / currentMapK);
      mapSvg.selectAll('.map-home circle').attr('r', function() {
        return parseFloat(this.getAttribute('data-base-r')) / currentMapK;
      });
      mapSvg.select('.home-label').attr('dy', `${-12 / currentMapK}px`)
        .attr('font-size', `${11 / currentMapK}px`);
    })
  );
  updateMapDots();
}

// Build the d attribute for a ballistic Bezier curve (control point lifted upward)
function ballisticD(x1, y1, x2, y2) {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const lift = Math.min(dist * 0.38, 160); // arc height (proportional to distance, capped)
  return `M${x1},${y1} Q${mx},${my - lift} ${x2},${y2}`;
}

// Start particle animation
function startMapAnim() {
  if (mapAnimId) return;
  const tick = () => {
    mapParticles.forEach(p => {
      p.t = (p.t + p.speed) % 1.0;
      try {
        const len = p.t * p.totalLength;
        const pt = p.pathEl.getPointAtLength(len);
        // Bright yellow-white at start → fade toward org colour as it advances
        const colorT = Math.min(p.t * 2.8, 1);
        const col = d3.interpolate('#fffde7', p.orgColor)(colorT);
        // Fade out over the final 15%
        const opacity = p.t > 0.85 ? (1 - p.t) / 0.15 : 1;
        d3.select(p.dotEl)
          .attr('cx', pt.x).attr('cy', pt.y)
          .attr('fill', col)
          .attr('opacity', p.visible ? opacity * p.freshness : 0)
          .attr('r', 2.5 / currentMapK);
      } catch(_) {}
    });
    mapAnimId = requestAnimationFrame(tick);
  };
  mapAnimId = requestAnimationFrame(tick);
}

function stopMapAnim() {
  if (mapAnimId) { cancelAnimationFrame(mapAnimId); mapAnimId = null; }
  mapParticles = [];
}

function updateMapDots() {
  if (!mapSvg || !mapProjection) return;
  const points = buildMapPoints();

  const maxS = Math.max(1, ...points.map(p => p.totalSessions), 1);
  const rScale = d => 5 + Math.sqrt(d.totalSessions / maxS) * 12;
  const colorScale = d3.scaleSequentialLog()
    .domain([1, Math.max(2, maxS)])
    .interpolator(d3.interpolate('#6d28d9', '#f97316'));

  const selNode = selectedMac ? nodes.find(n => n.id === selectedMac) : null;
  const selIp = selNode?.client?.ip || null;

  const { lat: _hLat, lon: _hLon } = getHomeCoord();
  const homeXY = mapProjection([_hLon, _hLat]);
  const [hx, hy] = homeXY;

  // ── Ballistic arcs (faint background arcs) ────────────────────────
  const arcsG = mapSvg.select('.map-arcs');
  arcsG.selectAll('path.map-arc')
    .data(points, d => d.key)
    .join('path')
    .attr('class', 'map-arc')
    .attr('d', d => {
      const xy = mapProjection([d.lon, d.lat]) || [-200, -200];
      return ballisticD(hx, hy, xy[0], xy[1]);
    })
    .attr('fill', 'none')
    .attr('stroke', d => colorScale(d.totalSessions))
    .attr('stroke-width', 0.5 / currentMapK)
    .attr('stroke-opacity', d => (!selIp || d.srcs.has(selIp) ? 0.18 : 0.03) * d.freshness);

  // ── Rebuild particles ─────────────────────────────────────────────
  stopMapAnim();
  const particlesG = mapSvg.select('.map-particles');
  particlesG.selectAll('*').remove();

  arcsG.selectAll('path.map-arc').each(function(d) {
    const pathEl = this;
    const totalLength = pathEl.getTotalLength();
    if (totalLength < 5) return;
    const pct      = d.totalSessions / maxS;
    const fresh    = d.freshness;
    // Lower freshness → slower and fewer particles
    const speed    = (0.0025 + pct * 0.0095) * (0.3 + 0.7 * fresh);
    const nParts   = fresh < 0.3 ? 1 : pct > 0.5 ? 4 : pct > 0.2 ? 3 : pct > 0.05 ? 2 : 1;
    const visible  = !selIp || d.srcs.has(selIp);
    const orgColor = colorScale(d.totalSessions);

    for (let i = 0; i < nParts; i++) {
      const t0 = i / nParts; // stagger start positions evenly
      const dotEl = particlesG.append('circle')
        .attr('class', 'map-particle')
        .attr('r', 2.5 / currentMapK)
        .attr('fill', '#fffde7')
        .attr('opacity', 0)
        .node();
      mapParticles.push({ pathEl, totalLength, t: t0, speed, orgColor, dotEl, visible, freshness: fresh });
    }
  });
  startMapAnim();

  // ── Dots (destination markers) ───────────────────────────────────
  const dotsG = mapSvg.select('.map-dots');
  dotsG.selectAll('circle.map-dot')
    .data(points, d => d.key)
    .join(
      enter => enter.append('circle').attr('class','map-dot')
        .attr('cx', d => (mapProjection([d.lon, d.lat]) || [-100,-100])[0])
        .attr('cy', d => (mapProjection([d.lon, d.lat]) || [-100,-100])[1])
        .attr('data-base-r', d => rScale(d))
        // Draw at full size immediately (avoided the 0→full transition that caused invisible periods on instant switch)
        .attr('r', d => rScale(d) / currentMapK)
        .attr('fill', d => colorScale(d.totalSessions))
        .attr('fill-opacity', 0.8)
        .attr('stroke', d => colorScale(d.totalSessions))
        .attr('stroke-width', 1).attr('stroke-opacity', 0.9)
        .on('mouseenter', showMapTooltip).on('mousemove', moveMapTooltip).on('mouseleave', hideMapTooltip),
      update => update
        .attr('cx', d => (mapProjection([d.lon, d.lat]) || [-100,-100])[0])
        .attr('cy', d => (mapProjection([d.lon, d.lat]) || [-100,-100])[1])
        .attr('data-base-r', d => rScale(d))
        .attr('fill', d => colorScale(d.totalSessions))
        .attr('stroke', d => colorScale(d.totalSessions))
        .attr('r', d => rScale(d) / currentMapK), // immediate update, no transition
      exit => exit.transition().duration(300).attr('r', 0).remove()
    )
    .attr('opacity', d => (!selIp || d.srcs.has(selIp) ? d.freshness : 0.08));
}
