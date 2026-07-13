// Pure data-transformation helpers extracted from graph.js for testability.
// No DOM, no D3, no side effects.

export function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(0x1F1E6 + code.charCodeAt(0) - 65, 0x1F1E6 + code.charCodeAt(1) - 65);
}

export function meshNodeId(mac) { return `__node_${mac}__`; }

export function linkEndpointId(endpoint) {
  return typeof endpoint === 'object' ? endpoint?.id : endpoint;
}

export function normalizeGraphLinks(candidateLinks, candidateNodes) {
  const nodeIds = new Set(candidateNodes.map(n => n.id));
  return candidateLinks
    .map(l => ({
      ...l,
      source: linkEndpointId(l.source),
      target: linkEndpointId(l.target),
    }))
    .filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));
}

export function currentGraphRangeKey(from, to, timeFilter) {
  if (timeFilter) {
    if (timeFilter === 'custom') return `custom:${from ?? ''}:${to ?? ''}`;
    if (timeFilter === 'today' || timeFilter === 'yesterday') {
      const day = from != null ? new Date(from).toISOString().slice(0, 10) : '';
      return `${timeFilter}:${day}:${to ?? ''}`;
    }
    return `${timeFilter}:open`;
  }
  return `${from ?? ''}:${to ?? ''}`;
}

export function routerTargetsFromSource(source, isMulti) {
  if (!isMulti) return undefined;
  const raw = String(source || 'yamaha').toLowerCase();
  const tokens = raw.split(/[,+]/).map(s => s.trim()).filter(Boolean);
  const hasCisco = tokens.includes('cisco');
  const hasYamaha = !hasCisco || tokens.includes('yamaha');
  const targets = [];
  if (hasYamaha) targets.push('__router__');
  if (hasCisco) targets.push('__router_cisco__');
  return targets.length ? targets : ['__router__'];
}

export function routerTargetsFromObservedBy(observedBy, source, isMulti) {
  if (!isMulti) return undefined;
  const ids = Array.isArray(observedBy) ? observedBy.map(id => String(id).toLowerCase()) : [];
  if (!ids.length) return routerTargetsFromSource(source, isMulti);
  const hasCisco = ids.some(id => id === 'cisco1' || id.startsWith('cisco-') || id.startsWith('legacy-cisco'));
  const hasYamaha = ids.some(id => id === 'yamaha1' || id.startsWith('yamaha-') || id.startsWith('legacy-yamaha'));
  const targets = [];
  if (hasYamaha) targets.push('__router__');
  if (hasCisco) targets.push('__router_cisco__');
  return targets.length ? targets : routerTargetsFromSource(source, isMulti);
}
