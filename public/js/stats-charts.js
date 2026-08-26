// Chart rendering for the statistics view (P2-28 stage 2, extracted from
// stats.js): app-distribution pie, per-destination timeline, and the
// destination bar chart. Owns the stack/line chart-mode toggle state.
import { t } from './i18n.js?v=__ASSET_VERSION__';
import { _buildAppSlices } from './utils.js?v=__ASSET_VERSION__';
import { truncateLabel, chartInnerWidth } from './stats-helpers.js?v=__ASSET_VERSION__';

const STATS_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#a78bfa'];

let chartMode = 'stack'; // 'stack' | 'line'

export function getChartMode() { return chartMode; }

/** Wire the stack/line toggle buttons; onChange fires after the mode flips. */
export function initChartModeButtons(onChange) {
  document.querySelectorAll('.chart-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chartMode = btn.dataset.mode;
      document.querySelectorAll('.chart-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      onChange();
    });
  });
}

const _PIE_CYBER_COLORS = [
  '#00e5ff', '#ff6b35', '#a855f7', '#22d3a3',
  '#f43f5e', '#fbbf24', '#38bdf8', '#ec4899',
];

export function drawAppPieChart(conns, precomputedSlices) {
  const cell = document.getElementById('st-app-pie');
  if (!cell) return;
  const svg = d3.select('#st-app-pie-svg');
  svg.selectAll('*').remove();

  const w = cell.clientWidth;
  const h = cell.clientHeight;
  if (!w || !h) return;

  svg.attr('viewBox', `0 0 ${w} ${h}`);
  svg.append('rect').attr('width', w).attr('height', h).attr('fill', '#050a14');

  const slices  = precomputedSlices || _buildAppSlices(
    conns || [], 8, t('stats.app.unknown'), t('stats.legend.other'), {
      agentSuffix: t('stats.app.agentSuffix'),
      inferredSuffix: t('stats.app.inferredSuffix'),
    }
  );
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
    .text(t('stats.app.attributions'));

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

export function drawTimeline(series, fromT, toT, buckets, bw, topOrgs) {
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
        .attr('fill', 'none')
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

export function drawBarChart(orgs /* [[name, count], ...] */) {
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
