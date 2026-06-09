// ─── Statistics view ─────────────────────────────────────────────────────────
const STATS_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#a78bfa'];
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
    document.getElementById('stats-timeline').style.display = 'none';
    document.getElementById('stats-bar').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  document.getElementById('stats-timeline').style.display = 'flex';
  document.getElementById('stats-bar').style.display = 'flex';

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
