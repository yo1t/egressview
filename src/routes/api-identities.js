// Management endpoints for scoped API identities (P2-61 Phase 2).
//
// The plaintext token is returned exactly once, in the create response. It is
// never stored, logged, audited, or exposed by any later read.
'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { ALL_PERMISSIONS } = require('../permissions');

const createSchema = z.object({
  label: z.string().trim().min(1).max(100),
  permissions: z.array(z.enum(ALL_PERMISSIONS)).min(1).max(ALL_PERMISSIONS.length),
  expiresInMs: z.number().int().positive(),
}).strict();

const idSchema = z.object({
  id: z.string().trim().min(1).max(100),
}).strict();

module.exports = function apiIdentityRoutes(ctx) {
  const { requireAdmin, apiIdentities, authAudit } = ctx;
  const router = Router();

  function audit(req, eventType, outcome, metadata) {
    authAudit.append({
      eventType,
      outcome,
      authMethod: req.authMethod,
      actor: req.actor,
      requestId: req.id,
      clientIp: req.ip,
      httpMethod: req.method,
      path: req.originalUrl,
      metadata,
    });
  }

  router.get('/auth/api-identities', requireAdmin, (_req, res) => {
    res.json({
      identities: apiIdentities.listIdentities(),
      availablePermissions: ALL_PERMISSIONS,
    });
  });

  router.post('/auth/api-identities', requireAdmin, (req, res) => {
    const parsed = parseRequest(createSchema, req.body, res);
    if (!parsed.ok) return;
    let created;
    try {
      created = apiIdentities.createIdentity(parsed.data);
    } catch (error) {
      audit(req, 'api_identity_created', 'failure');
      return res.status(400).json({ error: error.message });
    }
    // Metadata deliberately excludes the token and records only the identity id.
    audit(req, 'api_identity_created', 'success', {
      identityId: created.identity.id,
      permissions: created.identity.permissions,
      expiresAt: created.identity.expiresAt,
    });
    // The only time the plaintext leaves this process.
    res.status(201).json({ token: created.token, identity: created.identity });
  });

  router.post('/auth/api-identities/:id/revoke', requireAdmin, (req, res) => {
    const parsed = parseRequest(idSchema, req.params, res);
    if (!parsed.ok) return;
    const revoked = apiIdentities.revokeIdentity(parsed.data.id);
    audit(req, 'api_identity_revoked', revoked ? 'success' : 'failure', {
      identityId: parsed.data.id,
    });
    if (!revoked) return res.status(404).json({ error: 'API identity not found or already revoked' });
    res.json({ success: true });
  });

  return router;
};
