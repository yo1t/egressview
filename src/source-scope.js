'use strict';

const { z } = require('zod');

const sourceScopeShape = {
  sourceKind: z.enum(['router', 'agent']).optional(),
  sourceId: z.string().trim().min(1).max(128).optional(),
};

function validateSourceScopePair(data, ctx) {
  if (!!data.sourceKind !== !!data.sourceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sourceKind and sourceId must be provided together' });
  }
}

function readSourceScope(data) {
  return data?.sourceKind && data?.sourceId
    ? { sourceKind: data.sourceKind, sourceId: data.sourceId }
    : null;
}

function appendSourceScope(params, scope) {
  if (!scope) return params;
  params.set('sourceKind', scope.sourceKind);
  params.set('sourceId', scope.sourceId);
  return params;
}

function isKnownSourceScope(scope, { routerManager, agentIdentities } = {}) {
  if (!scope) return true;
  if (scope.sourceKind === 'router') {
    if (typeof routerManager?.list !== 'function') return false;
    return routerManager.list().some(router => router.enabled && String(router.id) === scope.sourceId);
  }
  if (scope.sourceKind === 'agent') {
    if (typeof agentIdentities?.listAgents !== 'function') return false;
    return agentIdentities.listAgents().some(agent => !agent.revokedAt && String(agent.agentId) === scope.sourceId);
  }
  return false;
}

function requireKnownSourceScope(data, dependencies, res) {
  const scope = readSourceScope(data);
  if (!isKnownSourceScope(scope, dependencies)) {
    res.status(400).json({ error: 'Selected collection source is unavailable' });
    return { ok: false, scope: null };
  }
  return { ok: true, scope };
}

module.exports = {
  sourceScopeShape,
  validateSourceScopePair,
  readSourceScope,
  appendSourceScope,
  isKnownSourceScope,
  requireKnownSourceScope,
};
