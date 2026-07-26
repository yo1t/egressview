'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const { z } = require('zod');
const { parseRequest } = require('../http-validation');
const { roleForOidcMatch } = require('../roles');

const configSchema = z.object({
  enabled: z.boolean(),
  clientId: z.string().trim().max(500),
  clientSecret: z.string().max(2000).optional(),
  allowedEmails: z.array(z.string().email().max(320)).max(100),
  allowedDomains: z.array(z.string().trim().min(1).max(253)).max(100),
}).strict();

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.coerce.number().int().positive().optional(),
}).strict();
const OIDC_STATE_COOKIE = 'egressview_oidc_state';

function publicBaseUrl(req, subpath) {
  const configured = process.env.EGRESSVIEW_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}${subpath || ''}`;
}

module.exports = function authSecurityRoutes(ctx) {
  const {
    requireAdmin, appState, saveConfig, sessions, authAudit, oidc,
    authCookies, subpath = '',
  } = ctx;
  const router = Router();

  router.get('/auth/status', (req, res) => {
    const auth = ctx.authenticateRequest(req);
    res.json({
      authenticated: Boolean(auth),
      authMethod: auth && auth !== 'admin' ? auth.authMethod : auth ? 'api-token' : null,
      oidcEnabled: appState.oidcConfig?.enabled === true,
      localLoginEnabled: true,
    });
  });

  router.get('/auth/methods', (_req, res) => {
    res.json({
      local: { enabled: true },
      google: { enabled: appState.oidcConfig?.enabled === true },
    });
  });

  router.get('/auth/security-config', requireAdmin, (_req, res) => {
    const config = appState.oidcConfig || {};
    res.json({
      oidc: {
        enabled: config.enabled === true,
        provider: 'google',
        clientId: config.clientId || '',
        clientSecretSet: Boolean(config.clientSecret),
        allowedEmails: config.allowedEmails || [],
        allowedDomains: config.allowedDomains || [],
      },
      sessionTtlDays: Number(process.env.EGRESSVIEW_SESSION_TTL_DAYS) || 30,
      trustedProxyConfigured: Boolean(process.env.EGRESSVIEW_TRUST_PROXY),
      warnings: [],
    });
  });

  router.post('/auth/security-config', requireAdmin, (req, res) => {
    const parsed = parseRequest(configSchema, req.body, res);
    if (!parsed.ok) return;
    const previous = appState.oidcConfig;
    const next = {
      ...parsed.data,
      clientSecret: parsed.data.clientSecret || previous?.clientSecret || '',
      allowedEmails: parsed.data.allowedEmails.map(value => value.toLowerCase()),
      allowedDomains: parsed.data.allowedDomains.map(value => value.toLowerCase()),
    };
    if (next.enabled &&
        (!next.clientId || !next.clientSecret ||
         (!next.allowedEmails.length && !next.allowedDomains.length))) {
      return res.status(400).json({
        error: 'Enabled Google OIDC requires credentials and an email or domain allowlist',
      });
    }
    appState.oidcConfig = next;
    try {
      saveConfig();
    } catch (error) {
      appState.oidcConfig = previous;
      return res.status(500).json({ error: 'OIDC configuration was not saved' });
    }
    authAudit.append({
      eventType: 'security_config_changed',
      authMethod: req.authMethod,
      actor: req.actor,
      requestId: req.id,
      clientIp: req.ip,
      httpMethod: req.method,
      path: req.originalUrl,
      metadata: { oidcEnabled: next.enabled, domainAllowlistCount: next.allowedDomains.length },
    });
    res.json({
      success: true,
      clientSecretSet: Boolean(next.clientSecret),
      warnings: [],
    });
  });

  router.post('/auth/oidc/test', requireAdmin, async (req, res) => {
    try {
      const result = await oidc.test(appState.oidcConfig);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  router.get('/auth/oidc/start', async (req, res) => {
    try {
      const callback = `${publicBaseUrl(req, subpath)}/api/auth/oidc/callback`;
      const authorizationUrl = await oidc.begin(appState.oidcConfig, callback);
      const state = new URL(authorizationUrl).searchParams.get('state');
      res.cookie(OIDC_STATE_COOKIE, state, authCookies.cookieOptions(req, {
        httpOnly: true,
        maxAge: 10 * 60_000,
        subpath,
      }));
      res.redirect(authorizationUrl);
    } catch (error) {
      authAudit.append({
        eventType: 'oidc_login_started',
        outcome: 'failure',
        clientIp: req.ip,
        requestId: req.id,
        httpMethod: req.method,
        path: req.originalUrl,
      });
      res.status(503).send('Google login is unavailable');
    }
  });

  router.get('/auth/oidc/callback', async (req, res) => {
    try {
      const cookieState = authCookies.parseCookies(req.headers.cookie)[OIDC_STATE_COOKIE] || '';
      const queryState = typeof req.query.state === 'string' ? req.query.state : '';
      const a = Buffer.from(cookieState);
      const b = Buffer.from(queryState);
      if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new Error('OIDC browser state validation failed');
      }
      res.clearCookie(OIDC_STATE_COOKIE, authCookies.cookieOptions(req, {
        httpOnly: true,
        subpath,
      }));
      const identity = await oidc.complete(appState.oidcConfig, req.query);
      // Derived from the server-side allowlist comparison, never from a claim
      // in the token. An explicit email entry is an operator, while a bulk
      // domain grant is read-only.
      const role = roleForOidcMatch(identity.allowlistMatch);
      if (!role) throw new Error('Google account is not in the allowlist');
      const session = sessions.createSession('Google OIDC', {
        authMethod: 'oidc',
        subject: identity.subject,
        role,
      });
      if (!session) throw new Error('Session creation failed');
      authCookies.setSessionCookies(req, res, session, subpath);
      authAudit.append({
        eventType: 'login',
        authMethod: 'oidc',
        actor: identity.subject,
        clientIp: req.ip,
        requestId: req.id,
        httpMethod: req.method,
        path: req.originalUrl,
      });
      res.redirect(`${subpath || '/'}`);
    } catch (error) {
      authAudit.append({
        eventType: 'login',
        outcome: 'failure',
        authMethod: 'oidc',
        clientIp: req.ip,
        requestId: req.id,
        httpMethod: req.method,
        path: req.originalUrl,
        metadata: { reason: String(error.message).slice(0, 120) },
      });
      res.status(401).send('Google login failed');
    }
  });

  router.get('/auth/audit-events', requireAdmin, (req, res) => {
    const parsed = parseRequest(auditQuerySchema, req.query, res);
    if (!parsed.ok) return;
    res.json({ events: authAudit.list(parsed.data) });
  });

  return router;
};
