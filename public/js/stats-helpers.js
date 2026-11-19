// Pure aggregation and layout helpers extracted from stats.js (P2-28 stage 1).
// No DOM, no D3, no i18n — labels and classifiers come in as arguments.

// Normalise summary.byTarget / byDst into a uniform row shape.
export function statsTargetRows(summary) {
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

// Aggregate app groups into [label, count] slices, folding the tail into
// an "other" slice. `guessApp` and the two labels are injected so the
// function stays i18n-free.
export function appSlicesFromSummary(groups, topN, {
  unknownLabel, otherLabel, guessApp, agentSuffix = '', inferredSuffix = '',
}) {
  const counts = new Map();
  for (const g of groups || []) {
    const base = g.app || guessApp(g.dport, g.proto, g.dstHost) || unknownLabel;
    const suffix = g.attribution === 'agent'
      ? agentSuffix
      : g.attribution === 'inferred' ? inferredSuffix : '';
    const label = `${base}${suffix}`;
    counts.set(label, (counts.get(label) || 0) + (g.count || 0));
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN).reduce((sum, [, count]) => sum + count, 0);
  if (rest > 0) top.push([otherLabel, rest]);
  return top;
}

// Convert summary.byLocation entries into map-point objects.
export function mapPointsFromSummary(summary) {
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

export function truncateLabel(s, maxLen) {
  s = String(s);
  return s.length > maxLen ? s.substring(0, maxLen - 1) + '…' : s;
}

export function chartInnerWidth(width, margin) {
  return Math.max(1, width - margin.left - margin.right);
}

// The bar chart's label column. It used to be a fixed 180px (110px on a
// phone), chosen by the window's width; in a narrow chart cell beside the
// device list that left no room for the bars at all. The column now takes at
// most 40% of the chart. Names are cut to what fits in it: a monospace
// character is about 0.6em wide, and the axis draws its text about 9px left
// of the bars. The old 32 characters at 10px came to about 190px, so a long
// name ran off the left edge of a 180px column.
export function barLabelLayout(width, isMobile) {
  const base = isMobile ? 110 : 180;
  const baseChars = isMobile ? 14 : 32;
  const fontPx = isMobile ? 9 : 10;
  const left = Math.max(48, Math.min(base, Math.round(width * 0.4)));
  const fits = Math.floor((left - 10) / (fontPx * 0.6));
  return { left, labelMax: Math.max(4, Math.min(baseChars, fits)) };
}
