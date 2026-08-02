'use strict';
// EgressView MCP Server — REST API wrapper
// Supports two transports:
//
//   stdio (default)  — for local Claude Desktop on the same machine
//   HTTP             — for nginx reverse-proxy access from any host
//
// ─── stdio mode ──────────────────────────────────────────────────────────────
// Claude Desktop config (~/.claude/claude_desktop_config.json):
//   { "mcpServers": { "egressview": {
//       "command": "node",
//       "args": ["/path/to/egressview/mcp-server.js"],
//       "env": {
//         "EGRESSVIEW_URL":   "http://your-server:3002",
//         "EGRESSVIEW_TOKEN": "your-admin-token"
//       }
//   }}}
//
// ─── HTTP mode (nginx proxy) ─────────────────────────────────────────────────
// Start:   MCP_PORT=3010 EGRESSVIEW_URL=http://localhost:3002 \
//            EGRESSVIEW_TOKEN=xxx node mcp-server.js
//
// Claude Desktop config (uses nginx URL):
//   { "mcpServers": { "egressview": {
//       "url": "https://your-nginx-host/mcp",
//       "headers": { "X-Admin-Token": "your-admin-token" }
//   }}}
//
// nginx/Apache snippet:  see docs/setup-mcp.md

const express = require('express');
const { AsyncLocalStorage } = require('node:async_hooks');
const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { z } = require('zod');
const { permissionForMcpTool } = require('./src/permission-matrix');
const { isApiIdentityToken } = require('./src/api-identities');
const { createMcpScopeMapping } = require('./src/mcp-scope-mapping');
const {
  createOAuthResourceServer,
  normalizeCompatibilityProfile,
  normalizeIssuer,
  assertCognitoIssuer,
  OAUTH_COMPATIBILITY_PROFILES,
} = require('./src/mcp-oauth');
const {
  resolveDeploymentProfile,
  resolveMcpBindConfig,
} = require('./src/deployment-profile');
const crypto = require('node:crypto');
const mcpAudit = require('./src/mcp-audit');
const { createMcpRateLimiter, rateLimitOptionsFromEnv } = require('./src/mcp-rate-limit');

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE      = (process.env.EGRESSVIEW_URL  || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN     = process.env.EGRESSVIEW_TOKEN || '';

function resolveHttpAuthConfig(env = process.env) {
  const mode = String(env.MCP_AUTH_MODE || 'token').trim().toLowerCase();
  if (mode === 'token') {
    const token = String(env.MCP_TOKEN || '').trim();
    const serviceToken = String(env.MCP_SERVICE_TOKEN || '').trim();
    const auditHashKey = String(env.MCP_AUDIT_HMAC_KEY || '').trim();
    if (!token) {
      throw new Error(
        'MCP_TOKEN must be set explicitly in HTTP token mode; '
        + 'it no longer defaults to EGRESSVIEW_TOKEN'
      );
    }
    if (env.EGRESSVIEW_TOKEN && token === env.EGRESSVIEW_TOKEN) {
      throw new Error('MCP_TOKEN must differ from EGRESSVIEW_TOKEN in HTTP token mode');
    }
    if (!isApiIdentityToken(serviceToken)) {
      throw new Error(
        'MCP_SERVICE_TOKEN must be a scoped EgressView API identity token in HTTP token mode'
      );
    }
    if (serviceToken === token || (env.EGRESSVIEW_TOKEN && serviceToken === env.EGRESSVIEW_TOKEN)) {
      throw new Error('MCP_SERVICE_TOKEN must differ from MCP_TOKEN and EGRESSVIEW_TOKEN');
    }
    if (auditHashKey.length < 32) {
      throw new Error('MCP_AUDIT_HMAC_KEY must contain at least 32 characters');
    }
    if (auditHashKey === token
        || auditHashKey === serviceToken
        || auditHashKey === env.EGRESSVIEW_TOKEN) {
      throw new Error('MCP_AUDIT_HMAC_KEY must be dedicated to MCP audit pseudonyms');
    }
    return Object.freeze({ mode, token, serviceToken, auditHashKey });
  }
  if (mode === 'oauth') {
    const issuer = String(env.MCP_OAUTH_ISSUER || '').trim();
    const resource = String(env.MCP_OAUTH_RESOURCE || '').trim();
    const readScope = String(env.MCP_OAUTH_READ_SCOPE || '').trim();
    const notesWriteScope = String(env.MCP_OAUTH_NOTES_WRITE_SCOPE || '').trim();
    const serviceToken = String(env.MCP_SERVICE_TOKEN || '').trim();
    const auditHashKey = String(env.MCP_AUDIT_HMAC_KEY || '').trim();
    if (!issuer || !resource || !readScope || !notesWriteScope || !serviceToken || !auditHashKey) {
      throw new Error(
        'MCP_OAUTH_ISSUER, MCP_OAUTH_RESOURCE, MCP_OAUTH_READ_SCOPE, '
        + 'MCP_OAUTH_NOTES_WRITE_SCOPE, MCP_SERVICE_TOKEN, and MCP_AUDIT_HMAC_KEY must be set '
        + 'in HTTP OAuth mode'
      );
    }
    if (!isApiIdentityToken(serviceToken)) {
      throw new Error('MCP_SERVICE_TOKEN must be a scoped EgressView API identity token');
    }
    if (env.EGRESSVIEW_TOKEN && serviceToken === env.EGRESSVIEW_TOKEN) {
      throw new Error('MCP_SERVICE_TOKEN must differ from EGRESSVIEW_TOKEN');
    }
    if (auditHashKey.length < 32) {
      throw new Error('MCP_AUDIT_HMAC_KEY must contain at least 32 characters');
    }
    if (auditHashKey === serviceToken || auditHashKey === env.EGRESSVIEW_TOKEN) {
      throw new Error('MCP_AUDIT_HMAC_KEY must be dedicated to MCP audit pseudonyms');
    }
    const compatibilityProfile = normalizeCompatibilityProfile(
      env.MCP_OAUTH_COMPATIBILITY_PROFILE
    );
    if (compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO) {
      assertCognitoIssuer(normalizeIssuer(issuer));
    }
    const scopeMapping = createMcpScopeMapping({ readScope, notesWriteScope });
    return Object.freeze({
      mode,
      issuer,
      resource,
      compatibilityProfile,
      requiredScope: readScope,
      readScope,
      notesWriteScope,
      scopesSupported: scopeMapping.scopesSupported,
      serviceToken,
      auditHashKey,
    });
  }
  throw new Error('MCP_AUTH_MODE must be either "token" or "oauth"');
}

function resolveMcpPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MCP_PORT must be an integer from 1 to 65535');
  }
  return port;
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

// A tool call that never returns holds a concurrency slot until the request
// deadline. Bounding the upstream call itself frees the slot sooner and gives
// a clearer failure than a whole-request timeout.
function createApiClient({
  base = BASE,
  token = TOKEN,
  requestId = null,
  requestSignal = null,
  timeoutMs = resolveTimeoutMs(process.env.MCP_API_TIMEOUT_MS, 15_000),
} = {}) {
  async function parseResponse(res, label) {
    if (!res.ok) throw new Error(`${label} returned ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`${label} returned non-JSON response`);
    }
  }

  // Carry the MCP request id into EgressView. The two audit trails are
  // deliberately separate stores; this is the key that joins them, so an
  // incident can be traced from "which OAuth subject asked" (MCP audit) to
  // "what the service identity then did" (EgressView audit).
  const correlationHeaders = requestId ? { 'X-Request-Id': requestId } : {};
  const signalForCall = () => {
    const apiDeadline = AbortSignal.timeout(timeoutMs);
    return requestSignal ? AbortSignal.any([requestSignal, apiDeadline]) : apiDeadline;
  };

  return Object.freeze({
    /** A client bound to one inbound request, for audit correlation. */
    withRequestId(id, signal = requestSignal) {
      return createApiClient({ base, token, requestId: id, requestSignal: signal, timeoutMs });
    },

    async get(path, params = {}) {
      const url = new URL(`${base}/api${path}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      const res = await fetch(url.toString(), {
        headers: { 'X-Admin-Token': token, ...correlationHeaders },
        signal: signalForCall(),
      });
      return parseResponse(res, `API ${path}`);
    },

    async post(path, body = {}) {
      const res = await fetch(`${base}/api${path}`, {
        method: 'POST',
        headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json', ...correlationHeaders },
        signal: signalForCall(),
        body: JSON.stringify(body),
      });
      return parseResponse(res, `API POST ${path}`);
    },
  });
}

const defaultApiClient = createApiClient();
async function apiPost(path, body = {}) { return defaultApiClient.post(path, body); }

const MCP_SERVICE_PERMISSIONS = Object.freeze(['network.read', 'notes.write']);

function createMcpServiceApiClient({ base = BASE, token } = {}) {
  const client = createApiClient({ base, token });
  let validationPromise = null;

  async function validateIdentity(validationClient = client) {
    if (!validationPromise) {
      validationPromise = validationClient.get('/auth/api-identities/self')
        .then((body) => {
          const actual = Array.isArray(body?.identity?.permissions)
            ? [...new Set(body.identity.permissions)].sort()
            : [];
          const expected = [...MCP_SERVICE_PERMISSIONS].sort();
          if (actual.length !== expected.length
              || actual.some((permission, index) => permission !== expected[index])) {
            throw new Error(
              'MCP service identity must grant exactly network.read and notes.write'
            );
          }
        })
        .catch((error) => {
          validationPromise = null;
          throw error;
        });
    }
    return validationPromise;
  }

  function wrap(inner) {
    return Object.freeze({
      // Binding a request id must not skip identity validation, so the wrapper
      // is rebuilt around the bound client rather than returning it directly.
      withRequestId(id, signal) {
        return wrap(inner.withRequestId(id, signal));
      },
      async get(path, params = {}) {
        await validateIdentity(inner);
        return inner.get(path, params);
      },
      async post(path, body = {}) {
        await validateIdentity(inner);
        return inner.post(path, body);
      },
    });
  }

  return wrap(client);
}

// ─── Period helpers ───────────────────────────────────────────────────────────

const PERIOD_MS = {
  '1h':  3_600_000,
  '6h':  21_600_000,
  '24h': 86_400_000,
  '7d':  604_800_000,
  '14d': 1_209_600_000,
};

const PERIOD_ENUM = z.enum(['1h', '6h', '24h', '7d', '14d']);

function periodRange(period) {
  const ms = PERIOD_MS[period] ?? PERIOD_MS['24h'];
  const to = Date.now();
  return { from: to - ms, to };
}

function tsToIso(ts) { return ts ? new Date(ts).toISOString() : null; }
function ok(obj)     { return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }; }

// ─── Tool registration (shared between stdio and HTTP transports) ─────────────

function registerTool(server, name, description, inputShape, handler) {
  if (!permissionForMcpTool(name)) {
    throw new Error(`MCP tool is missing a permission classification: ${name}`);
  }
  server.registerTool(name, {
    description,
    inputSchema: z.object(inputShape),
  }, handler);
}

function buildMcpServer({ includeWriteTools = true, apiClient = defaultApiClient } = {}) {
  const server = new McpServer({
    name: 'egressview',
    version: require('./package.json').version,
  });

  // ① Threat summary
  registerTool(server,
    'get_threat_summary',
    'Counts sessions classified as safe / warn / danger for the given time period.',
    { period: PERIOD_ENUM.default('24h').describe('Time window') },
    async ({ period }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections/threat-counts', { from, to });
      return ok({ period, safe: data.safe, warn: data.warn, danger: data.danger, total: data.safe + data.warn + data.danger });
    }
  );

  // ② Traffic summary
  registerTool(server,
    'get_traffic_summary',
    'Returns total session count, unique destination count, and unique device count for the period.',
    { period: PERIOD_ENUM.default('24h').describe('Time window') },
    async ({ period }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections/summary', { from, to, buckets: 1 });
      return ok({
        period,
        totalSessions:      data.total        ?? 0,
        uniqueDestinations: data.byDst?.length    ?? 0,
        uniqueDevices:      data.byDevice?.length ?? 0,
      });
    }
  );

  // ③ Top destinations
  registerTool(server,
    'get_top_destinations',
    'Returns the most frequently contacted destinations, ranked by session count, with country, org, and threat level.',
    {
      period: PERIOD_ENUM.default('24h'),
      limit:  z.number().int().min(1).max(100).default(20).describe('Max rows'),
    },
    async ({ period, limit }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections/summary', { from, to, buckets: 1 });
      const rows = (data.byDst ?? []).slice(0, limit).map(d => ({
        dst:       d.dst,
        host:      d.dstHost  || null,
        country:   d.country  || null,
        org:       d.org      || null,
        sessions:  d.count,
        threat:    d.threat   || null,
        firstSeen: tsToIso(d.firstSeen),
        lastSeen:  tsToIso(d.lastSeen),
      }));
      return ok({ period, count: rows.length, destinations: rows });
    }
  );

  // ④ Device traffic
  registerTool(server,
    'get_device_traffic',
    'Per-device traffic. Omit src to list all devices. Pass src IP to get that device\'s top destinations.',
    {
      period: PERIOD_ENUM.default('24h'),
      src:    z.string().optional().describe('Source IP (omit for all devices)'),
      limit:  z.number().int().min(1).max(50).default(10),
    },
    async ({ period, src, limit }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections/summary', { from, to, buckets: 1, src: src || undefined });
      if (src) {
        const topDst = (data.byDst ?? []).slice(0, limit).map(d => ({
          dst:      d.dst,
          host:     d.dstHost || null,
          country:  d.country || null,
          org:      d.org     || null,
          sessions: d.count,
          threat:   d.threat  || null,
        }));
        return ok({ period, src, topDestinations: topDst });
      }
      const devRows = (data.byDevice ?? []).slice(0, limit).map(d => ({
        src:       d.src,
        mac:       d.srcMac    || null,
        vendor:    d.srcVendor || null,
        sessions:  d.count,
        firstSeen: tsToIso(d.firstSeen),
        lastSeen:  tsToIso(d.lastSeen),
      }));
      return ok({ period, count: devRows.length, devices: devRows });
    }
  );

  // ⑤ New nodes
  registerTool(server,
    'get_new_nodes',
    'Lists devices and destinations that were seen for the very first time during the period.',
    { period: PERIOD_ENUM.default('24h') },
    async ({ period }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections/new-nodes', { from, to });
      return ok({
        period,
        deviceCount:      data.deviceCount,
        destinationCount: data.destinationCount,
        newDevices: (data.newDevices ?? []).map(d => ({
          src:       d.src,
          mac:       d.srcMac     || null,
          vendor:    d.srcVendor  || null,
          dnsName:   d.srcDnsName || d.srcMdnsName || null,
          firstSeen: tsToIso(d.firstSeen),
        })),
        newDestinations: (data.newDestinations ?? []).map(d => ({
          dst:       d.dst,
          host:      d.dstHost || null,
          country:   d.country || null,
          org:       d.org     || null,
          firstSeen: tsToIso(d.firstSeen),
        })),
      });
    }
  );

  // ⑥ Threat connections
  registerTool(server,
    'get_threat_connections',
    'Lists destinations flagged as threats. confidence: "low"=warn, "high"=danger, "all"=both.',
    {
      period:     PERIOD_ENUM.default('24h'),
      confidence: z.enum(['low', 'high', 'all']).default('all'),
      limit:      z.number().int().min(1).max(200).default(50),
    },
    async ({ period, confidence, limit }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections/threat-connections', { from, to, confidence, limit });
      return ok({ period, confidence, count: data.count, threats: data.threats ?? [] });
    }
  );

  // ⑦ Alerts
  registerTool(server,
    'get_alerts',
    'Returns recent detection alerts from the notification log (threats, new devices, beacons).',
    {
      period: PERIOD_ENUM.default('24h'),
      limit:  z.number().int().min(1).max(200).default(50),
    },
    async ({ period, limit }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/notification-log', { from, to });
      const alerts = (data.logs ?? []).slice(0, limit).map(r => ({
        type:       r.type,
        detectedAt: tsToIso(r.detectedAt),
        dst:        r.dst        || null,
        src:        r.src        || null,
        feed:       r.feed       || null,
        confidence: r.confidence || null,
        detail:     r.detail     || null,
      }));
      return ok({ period, count: alerts.length, alerts });
    }
  );

  // ⑧ Devices
  registerTool(server,
    'get_devices',
    'Lists all known devices with MAC address, vendor, names, status, and last-seen time.',
    {
      include_archived: z.boolean().default(false).describe('Include archived/merged devices'),
    },
    async ({ include_archived }) => {
      const data = await apiClient.get('/devices', { includeArchived: include_archived ? '1' : undefined });
      const devs = (data.devices ?? data ?? []).map(d => ({
        deviceId:  d.deviceId,
        ip:        d.ip,
        mac:       d.mac      || null,
        vendor:    d.vendor   || null,
        dnsName:   d.dnsName  || null,
        mdnsName:  d.mdnsName || null,
        status:    d.status,
        firstSeen: tsToIso(d.firstSeen),
        lastSeen:  tsToIso(d.lastSeen),
      }));
      return ok({ count: devs.length, devices: devs });
    }
  );

  // ⑨ Query connections
  registerTool(server,
    'query_connections',
    'Searches the connection log with optional src/dst filters. Returns matching rows with threat assessment.',
    {
      period: PERIOD_ENUM.default('24h'),
      src:    z.string().optional().describe('Filter by source IP or hostname (contains match)'),
      dst:    z.string().optional().describe('Filter by destination IP or hostname (contains match)'),
      limit:  z.number().int().min(1).max(500).default(100),
    },
    async ({ period, src, dst, limit }) => {
      const { from, to } = periodRange(period);
      const data = await apiClient.get('/connections', {
        from, to, limit, offset: 0,
        fSrc: src || undefined,
        fDst: dst || undefined,
      });
      const out = (data.connections ?? []).map(r => ({
        src:       r.src,
        dst:       r.dst,
        host:      r.dstHost  || null,
        dport:     r.dport,
        proto:     r.proto,
        country:   r.country  || null,
        org:       r.org      || null,
        threat:    r.threat   || null,
        firstSeen: tsToIso(r.firstSeen),
        lastSeen:  tsToIso(r.lastSeen),
      }));
      return ok({ period, src: src || null, dst: dst || null, count: out.length, connections: out });
    }
  );

  // ⑩ Get device notes
  registerTool(server,
    'get_device_notes',
    'Returns memo notes attached to devices. Omit src to list all devices that have a note. Pass a source IP to get that device\'s note.',
    {
      src: z.string().optional().describe('Source IP address (omit for all devices with notes)'),
    },
    async ({ src }) => {
      const data = await apiClient.get('/devices');
      const devs = data.devices ?? [];
      if (src) {
        const dev = devs.find(d => d.ip === src);
        if (!dev) return ok({ src, found: false, note: null });
        return ok({
          src,
          found:     true,
          deviceId:  dev.deviceId  || null,
          mac:       dev.mac       || null,
          vendor:    dev.vendor    || null,
          dnsName:   dev.dnsName   || dev.mdnsName || null,
          note:      dev.note      || null,
        });
      }
      const withNotes = devs
        .filter(d => d.note)
        .map(d => ({
          src:      d.ip,
          deviceId: d.deviceId || null,
          mac:      d.mac      || null,
          vendor:   d.vendor   || null,
          dnsName:  d.dnsName  || d.mdnsName || null,
          note:     d.note,
        }));
      return ok({ count: withNotes.length, devices: withNotes });
    }
  );

  if (includeWriteTools) {
    // ⑪ Set device note
    registerTool(server,
      'set_device_note',
      'Sets or updates the memo note for a device identified by its source IP address. Pass an empty string to delete the note.',
      {
        src:  z.string().describe('Source IP address of the device'),
        note: z.string().max(500).describe('Memo text to save (empty string deletes the note)'),
      },
      async ({ src, note }) => {
        await apiClient.post('/notes', { ip: src, note });
        const trimmed = note.trim();
        return ok({ src, note: trimmed || null, deleted: !trimmed });
      }
    );
  }

  return server;
}

// ─── stdio transport ──────────────────────────────────────────────────────────

async function startStdio() {
  if (!TOKEN) {
    process.stderr.write(
      '[egressview-mcp] WARNING: EGRESSVIEW_TOKEN is not set — API calls will fail\n'
    );
  }
  await serveStdio(() => buildMcpServer());
}

// ─── HTTP transport (for nginx proxy) ────────────────────────────────────────
// Each request creates its own McpServer + transport (stateless).
// The auth check is done here; nginx does NOT need to strip/add tokens.

function createAuthMiddleware(token) {
  const crypto = require('crypto');
  return (req, res, next) => {
    const provided = req.headers['x-admin-token']
      || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(provided || '');
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.mcpAuth = Object.freeze({
      subject: 'private-token',
      clientId: 'private-http',
      scopes: MCP_SERVICE_PERMISSIONS,
    });
    next();
  };
}

function createToolScopeMiddleware(scopeMapping, oauth) {
  return (req, res, next) => {
    if (req.method !== 'POST' || req.body?.method !== 'tools/call') return next();
    const authorization = scopeMapping.authorizeTool(
      req.body?.params?.name,
      req.mcpAuth?.scopes
    );
    if (!authorization.classified) return next();
    if (authorization.allowed) return next();

    const challenge = oauth.challenge(
      'insufficient_scope',
      authorization.requiredScopes.join(' ')
    );
    res.set('WWW-Authenticate', challenge);
    return res.status(403).json({ error: 'insufficient_scope' });
  };
}

// Correlate a request across the rate limiter, the OAuth boundary and the
// tool call. A caller-supplied id is accepted only in a safe shape.
function resolveTimeoutMs(value, fallback) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  // A zero or negative timeout would disable the deadline entirely, which is
  // the failure this exists to prevent. Node timers also overflow above a
  // signed 32-bit delay, so keep the operational setting deliberately bounded.
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 600_000
    ? parsed
    : fallback;
}

function requestIdFor(req) {
  const supplied = String(req.get?.('X-Request-Id') || '').trim();
  if (/^[A-Za-z0-9._-]{1,100}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

// req.mcpAuth is populated by the OAuth layer with a normalized, verified
// identity. Before authentication it is absent, and the hashes are then null
// by design rather than by accident.
function auditContext(req) {
  return {
    subject: req.mcpAuth?.subject || null,
    clientId: req.mcpAuth?.clientId || null,
    scopes: req.mcpAuth?.scopes || null,
    requestId: req.mcpRequestId,
  };
}

function createRequestContextMiddleware() {
  return (req, _res, next) => {
    req.mcpRequestId = requestIdFor(req);
    req.mcpStartedAt = Date.now();
    next();
  };
}

// Two passes are required, and the order is load-bearing.
//
// The first runs before the body is parsed and before authentication, so a
// flood of unauthenticated or malformed requests is rejected without spending
// JSON parsing or JWKS work on it. At that point there is no identity, so only
// the global window and the concurrency cap can apply.
//
// The second runs after authentication, once req.mcpAuth carries a verified
// subject and client id. Applying per-identity limits any earlier would have
// silently done nothing.
function createRateLimitMiddleware(limiter, { stage = 'pre-auth' } = {}) {
  return (req, res, next) => {
    const identified = stage === 'post-auth';
    const verdict = limiter.check(
      identified
        ? { subject: req.mcpAuth?.subject, clientId: req.mcpAuth?.clientId, skipGlobal: true }
        : {}
    );
    if (verdict.allowed) {
      // Only the pre-auth pass holds a concurrency slot; taking a second one
      // after authentication would double-count the same request.
      if (!identified) {
        const release = limiter.acquire();
        let done = false;
        const finish = () => { if (!done) { done = true; release(); } };
        res.on('finish', finish);
        res.on('close', finish);
      }
      return next();
    }
    mcpAudit.append({
      eventType: 'mcp_rate_limited',
      outcome: 'failure',
      reason: verdict.reason,
      mcpMethod: req.body?.method,
      httpStatus: 429,
      ...auditContext(req),
      durationMs: Date.now() - req.mcpStartedAt,
    });
    res.set('Retry-After', String(verdict.retryAfterSeconds));
    return res.status(429).json({ error: 'rate_limited' });
  };
}

// Classifies the outcome of an authenticated MCP request for the audit trail.
// Reason codes only — never provider text, which can echo token contents.
function createAuditMiddleware() {
  return (req, res, next) => {
    res.on('finish', () => {
      const toolName = req.body?.method === 'tools/call' ? req.body?.params?.name : null;
      const mcpMethod = typeof req.body?.method === 'string' ? req.body.method : null;
      const status = res.statusCode;
      // A streamed response that blew its deadline still reports 200; the
      // deadline flag is the authoritative signal, not the status code.
      const outcome = req.mcpTimedOut || status >= 400 ? 'failure' : 'success';
      let reason = null;
      if (status === 401) reason = res.get('WWW-Authenticate')?.includes('invalid_token')
        ? 'invalid_token' : 'unauthorized';
      else if (status === 403) reason = 'insufficient_scope';
      else if (status === 429) return; // already audited by the limiter
      else if (req.mcpTimedOut) reason = 'request_timeout';
      else if (status === 400) reason = 'bad_request';
      else if (status === 404) reason = 'not_found';
      else if (status === 405) reason = 'method_not_allowed';
      else if (status === 413) reason = 'payload_too_large';
      else if (status >= 400 && status < 500) reason = 'client_error';
      else if (status >= 500) reason = 'server_error';
      mcpAudit.append({
        eventType: toolName ? 'mcp_tool_call' : 'mcp_request',
        outcome,
        reason,
        toolName,
        mcpMethod,
        httpStatus: status,
        ...auditContext(req),
        durationMs: Date.now() - req.mcpStartedAt,
      });
    });
    next();
  };
}

function initializeMcpAudit(authConfig) {
  mcpAudit.initDb(process.env.MCP_AUDIT_DB_PATH || undefined, {
    hashKey: authConfig.auditHashKey,
  });
  mcpAudit.assertWritable();
  mcpAudit.prune();
  mcpAudit.setWriteFailureHandler((error, total) => {
    if (total === 1 || total % 100 === 0) {
      process.stderr.write(
        `[egressview-mcp] AUDIT WRITE FAILED (${total} total): ${error.message}\n`
      );
    }
  });
}

async function startHttp(
  port,
  authConfig = resolveHttpAuthConfig(),
  { bindAddress = '127.0.0.1' } = {}
) {
  const app = express();
  const MAX_BODY = process.env.MCP_MAX_BODY || '256kb';
  const limiter = createMcpRateLimiter(rateLimitOptionsFromEnv());

  let oauth = null;
  let scopeMapping = null;
  let internalApiClient = createMcpServiceApiClient({ token: authConfig.serviceToken });
  initializeMcpAudit(authConfig);

  // Every HTTP profile receives the same pre-auth flood protection, audit,
  // bounded parser, and request deadline. OAuth adds verified user/client
  // identity; private token mode records a stable credential identity.
  app.use('/mcp', createRequestContextMiddleware());
  app.use('/mcp', createAuditMiddleware());
  app.use('/mcp', createRateLimitMiddleware(limiter, { stage: 'pre-auth' }));

  if (authConfig.mode === 'oauth') {
    oauth = createOAuthResourceServer(authConfig);
    if (oauth.compatibilityProfile === OAUTH_COMPATIBILITY_PROFILES.COGNITO) {
      process.stderr.write(
        '[egressview-mcp] Cognito compatibility profile enabled; '
        + 'PKCE S256 wire evidence is required before publication\n'
      );
    }
    scopeMapping = createMcpScopeMapping({
      readScope: authConfig.readScope || authConfig.requiredScope,
      notesWriteScope: authConfig.notesWriteScope,
    });
    const sendMetadata = (_req, res) => res.json(oauth.metadata);
    const metadataPaths = new Set([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      new URL(oauth.protectedResourceMetadataUrl).pathname,
    ]);
    for (const path of metadataPaths) app.get(path, sendMetadata);
    // Order matters: context and limits first, so an unauthenticated flood is
    // rejected before any JWKS work, then authentication, then scope, then the
    // audit hook that classifies whatever the earlier layers decided.
    // Order is load-bearing:
    //   context  -> every later layer can correlate on one request id
    //   audit    -> registered early so it observes whatever any layer decides
    //   limit    -> rejects floods before JSON parsing or JWKS work
    //   body     -> bounded parse, scoped to /mcp only
    //   oauth    -> establishes the verified identity
    //   limit    -> per-subject and per-client, now that identity exists
    //   scope    -> per-tool authorization
    app.use('/mcp', express.json({ limit: MAX_BODY }));
    app.use('/mcp', oauth.middleware());
    app.use('/mcp', createRateLimitMiddleware(limiter, { stage: 'post-auth' }));
    app.use('/mcp', createToolScopeMiddleware(scopeMapping, oauth));
  } else {
    // Private token mode accepts the dedicated token in either supported header.
    app.use('/mcp', createAuthMiddleware(authConfig.token));
    app.use('/mcp', createRateLimitMiddleware(limiter, { stage: 'post-auth' }));
    app.use('/mcp', express.json({ limit: MAX_BODY }));
  }

  // Without a deadline a stalled upstream call holds its concurrency slot for
  // ever; MCP_MAX_CONCURRENT such requests would wedge the endpoint closed.
  const requestTimeoutMs = resolveTimeoutMs(process.env.MCP_REQUEST_TIMEOUT_MS, 30_000);
  const requestStorage = new AsyncLocalStorage();

  // The v2 SDK owns era classification. Its default legacy posture serves
  // 2025-era initialize traffic statelessly, while the same factory serves
  // 2026-07-28 server/discover traffic. AsyncLocalStorage carries only
  // request-local authorization and cancellation state into that shared
  // factory; no MCP session state is retained.
  const mcpHandler = createMcpHandler(() => {
    const requestContext = requestStorage.getStore();
    if (!requestContext) {
      throw new Error('MCP request context is unavailable');
    }
    const { req, requestController } = requestContext;
    const includeWriteTools = authConfig.mode !== 'oauth'
      || scopeMapping.authorizeTool('set_device_note', req.mcpAuth?.scopes).allowed;
    const apiClient = req.mcpRequestId && typeof internalApiClient.withRequestId === 'function'
      ? internalApiClient.withRequestId(req.mcpRequestId, requestController.signal)
      : internalApiClient;
    return buildMcpServer({ includeWriteTools, apiClient });
  }, {
    legacy: 'stateless',
    onerror(error) {
      process.stderr.write(`[egressview-mcp] ${error.message}\n`);
    },
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror(error) {
      process.stderr.write(`[egressview-mcp] ${error.message}\n`);
    },
  });

  // The shared dual-era handler handles modern POST requests and the stateless
  // legacy POST fallback. Legacy GET/DELETE session operations intentionally
  // remain unsupported, as they were before this migration.
  const handleMcp = async (req, res) => {
    const requestController = new AbortController();

    // Record the timeout as a flag rather than writing a row here: the audit
    // middleware still fires on finish, and two writes would leave the trail
    // claiming both request_timeout and server_error for one request.
    //
    // The Streamable HTTP transport sends headers as soon as it starts the SSE
    // stream, so for a streaming response the status can no longer be changed
    // to 504. The deadline still does the work that matters: it marks the
    // request for audit and releases the concurrency slot, which is what stops
    // stalled calls wedging the endpoint closed.
    const deadline = setTimeout(() => {
      req.mcpTimedOut = true;
      requestController.abort(new DOMException('MCP request timed out', 'TimeoutError'));
      if (res.writableEnded) return;
      if (res.headersSent) res.end();
      else res.status(504).json({ error: 'request_timeout' });
    }, requestTimeoutMs);
    deadline.unref?.();

    // Release the timer and upstream API signal exactly once, however the
    // request ends. The SDK owns each per-request McpServer lifecycle.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      if (!requestController.signal.aborted) {
        requestController.abort(new DOMException('MCP response closed', 'AbortError'));
      }
    };
    res.on('close', release);
    res.on('finish', release);

    try {
      await requestStorage.run(
        { req, requestController },
        () => nodeMcpHandler(req, res, req.body)
      );
    } catch (err) {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
    } finally {
      // A response that never emits close or finish still releases here.
      if (res.writableEnded || res.headersSent === false) release();
    }
  };

  app.post('/mcp',   handleMcp);
  app.get('/mcp',    handleMcp);
  app.delete('/mcp', handleMcp);

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, bindAddress, (error) => {
      if (error) {
        reject(error);
        return;
      }
      const actualPort = httpServer.address().port;
      process.stderr.write(
        `[egressview-mcp] HTTP transport listening on ${bindAddress}:${actualPort}/mcp\n`
      );
      process.stderr.write(`[egressview-mcp] HTTP authentication mode: ${authConfig.mode}\n`);
      process.stderr.write(`[egressview-mcp] Proxying API calls to ${BASE}\n`);
      const limits = limiter.config;
      process.stderr.write(
        `[egressview-mcp] Limits: ${limits.globalPerMinute}/min global, `
        + `${limits.perSubjectPerMinute}/min credential, ${limits.perClientPerMinute}/min client, `
        + `${limits.maxConcurrent} concurrent\n`
      );
      httpServer.once('close', () => {
        mcpHandler.close().catch(() => {});
      });
      resolve(httpServer);
    });
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  const httpEnabled = process.env.MCP_PORT !== undefined && process.env.MCP_PORT !== '';
  if (httpEnabled) {
    let port;
    let authConfig;
    let deploymentProfile;
    let bindConfig;
    try {
      port = resolveMcpPort(process.env.MCP_PORT);
      authConfig = resolveHttpAuthConfig();
      deploymentProfile = resolveDeploymentProfile(process.env, {
        httpEnabled: true,
        authMode: authConfig.mode,
      });
      bindConfig = resolveMcpBindConfig(process.env, deploymentProfile);
    } catch (err) {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `[egressview-mcp] Deployment profile: ${deploymentProfile.id}`
      + `${deploymentProfile.configured ? '' : ' (inferred)'}\n`
    );
    startHttp(port, authConfig, { bindAddress: bindConfig.address }).catch(err => {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      process.exit(1);
    });
  } else {
    try {
      const deploymentProfile = resolveDeploymentProfile(process.env, {
        httpEnabled: false,
        authMode: null,
      });
      process.stderr.write(
        `[egressview-mcp] Deployment profile: ${deploymentProfile.id}`
        + `${deploymentProfile.configured ? '' : ' (inferred)'}\n`
      );
    } catch (err) {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      process.exit(1);
    }
    startStdio().catch(err => {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      process.exit(1);
    });
  }
}

// ─── Test exports (only when required, not when run directly) ─────────────────
module.exports._createAuthMiddleware = createAuthMiddleware;
module.exports._buildMcpServer       = buildMcpServer;
module.exports._apiPost              = apiPost;
module.exports._createApiClient      = createApiClient;
module.exports._createMcpServiceApiClient = createMcpServiceApiClient;
module.exports._createToolScopeMiddleware = createToolScopeMiddleware;
module.exports._resolveHttpAuthConfig = resolveHttpAuthConfig;
module.exports._resolveMcpPort        = resolveMcpPort;
module.exports._startHttp             = startHttp;
