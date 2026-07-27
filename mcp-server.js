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
const { McpServer }                      = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport }           = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport }  = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { permissionForMcpTool } = require('./src/permission-matrix');
const { isApiIdentityToken } = require('./src/api-identities');
const { createMcpScopeMapping } = require('./src/mcp-scope-mapping');
const { createOAuthResourceServer } = require('./src/mcp-oauth');
const crypto = require('node:crypto');
const mcpAudit = require('./src/mcp-audit');
const { createMcpRateLimiter, rateLimitOptionsFromEnv } = require('./src/mcp-rate-limit');

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE      = (process.env.EGRESSVIEW_URL  || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN     = process.env.EGRESSVIEW_TOKEN || '';

function resolveHttpAuthConfig(env = process.env) {
  const mode = String(env.MCP_AUTH_MODE || 'token').trim().toLowerCase();
  if (mode === 'token') {
    if (!env.MCP_TOKEN) {
      throw new Error(
        'MCP_TOKEN must be set explicitly in HTTP token mode; '
        + 'it no longer defaults to EGRESSVIEW_TOKEN'
      );
    }
    if (env.EGRESSVIEW_TOKEN && env.MCP_TOKEN === env.EGRESSVIEW_TOKEN) {
      throw new Error('MCP_TOKEN must differ from EGRESSVIEW_TOKEN in HTTP token mode');
    }
    return Object.freeze({ mode, token: env.MCP_TOKEN });
  }
  if (mode === 'oauth') {
    const issuer = String(env.MCP_OAUTH_ISSUER || '').trim();
    const resource = String(env.MCP_OAUTH_RESOURCE || '').trim();
    const readScope = String(env.MCP_OAUTH_READ_SCOPE || '').trim();
    const notesWriteScope = String(env.MCP_OAUTH_NOTES_WRITE_SCOPE || '').trim();
    const serviceToken = String(env.MCP_SERVICE_TOKEN || '').trim();
    if (!issuer || !resource || !readScope || !notesWriteScope || !serviceToken) {
      throw new Error(
        'MCP_OAUTH_ISSUER, MCP_OAUTH_RESOURCE, MCP_OAUTH_READ_SCOPE, '
        + 'MCP_OAUTH_NOTES_WRITE_SCOPE, and MCP_SERVICE_TOKEN must be set '
        + 'in HTTP OAuth mode'
      );
    }
    if (!isApiIdentityToken(serviceToken)) {
      throw new Error('MCP_SERVICE_TOKEN must be a scoped EgressView API identity token');
    }
    if (env.EGRESSVIEW_TOKEN && serviceToken === env.EGRESSVIEW_TOKEN) {
      throw new Error('MCP_SERVICE_TOKEN must differ from EGRESSVIEW_TOKEN');
    }
    const scopeMapping = createMcpScopeMapping({ readScope, notesWriteScope });
    return Object.freeze({
      mode,
      issuer,
      resource,
      requiredScope: readScope,
      readScope,
      notesWriteScope,
      scopesSupported: scopeMapping.scopesSupported,
      serviceToken,
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

function createApiClient({ base = BASE, token = TOKEN } = {}) {
  async function parseResponse(res, label) {
    if (!res.ok) throw new Error(`${label} returned ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`${label} returned non-JSON response`);
    }
  }

  return Object.freeze({
    async get(path, params = {}) {
      const url = new URL(`${base}/api${path}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      const res = await fetch(url.toString(), {
        headers: { 'X-Admin-Token': token },
      });
      return parseResponse(res, `API ${path}`);
    },

    async post(path, body = {}) {
      const res = await fetch(`${base}/api${path}`, {
        method: 'POST',
        headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' },
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

  async function validateIdentity() {
    if (!validationPromise) {
      validationPromise = client.get('/auth/api-identities/self')
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

  return Object.freeze({
    async get(path, params = {}) {
      await validateIdentity();
      return client.get(path, params);
    },
    async post(path, body = {}) {
      await validateIdentity();
      return client.post(path, body);
    },
  });
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

function registerTool(server, name, ...args) {
  if (!permissionForMcpTool(name)) {
    throw new Error(`MCP tool is missing a permission classification: ${name}`);
  }
  server.tool(name, ...args);
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
  const server    = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
function requestIdFor(req) {
  const supplied = String(req.get?.('X-Request-Id') || '').trim();
  if (/^[A-Za-z0-9._-]{1,100}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

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

// Runs before authentication so an unauthenticated flood is also bounded.
function createRateLimitMiddleware(limiter) {
  return (req, res, next) => {
    const verdict = limiter.check({
      subject: req.mcpAuth?.subject,
      clientId: req.mcpAuth?.clientId,
    });
    if (verdict.allowed) {
      const release = limiter.acquire();
      let done = false;
      const finish = () => { if (!done) { done = true; release(); } };
      res.on('finish', finish);
      res.on('close', finish);
      return next();
    }
    mcpAudit.append({
      eventType: 'mcp_rate_limited',
      outcome: 'failure',
      reason: verdict.reason,
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
      const status = res.statusCode;
      const outcome = status < 400 ? 'success' : 'failure';
      let reason = null;
      if (status === 401) reason = res.get('WWW-Authenticate')?.includes('invalid_token')
        ? 'invalid_token' : 'unauthorized';
      else if (status === 403) reason = 'insufficient_scope';
      else if (status === 429) return; // already audited by the limiter
      else if (status >= 500) reason = 'server_error';
      mcpAudit.append({
        eventType: toolName ? 'mcp_tool_call' : 'mcp_request',
        outcome,
        reason,
        toolName,
        ...auditContext(req),
        durationMs: Date.now() - req.mcpStartedAt,
      });
    });
    next();
  };
}

async function startHttp(port, authConfig = resolveHttpAuthConfig()) {
  const app = express();
  // Bound the body before anything parses or authenticates it.
  app.use(express.json({ limit: process.env.MCP_MAX_BODY || '256kb' }));

  const limiter = createMcpRateLimiter(rateLimitOptionsFromEnv());

  let oauth = null;
  let scopeMapping = null;
  let internalApiClient = defaultApiClient;
  if (authConfig.mode === 'oauth') {
    oauth = createOAuthResourceServer(authConfig);
    scopeMapping = createMcpScopeMapping({
      readScope: authConfig.readScope || authConfig.requiredScope,
      notesWriteScope: authConfig.notesWriteScope,
    });
    internalApiClient = createMcpServiceApiClient({ token: authConfig.serviceToken });
    // Audit is scoped to the public OAuth endpoint. A failure to open it must
    // not stop the process: losing audit is bad, refusing to run is worse for
    // the local collection this host also performs.
    try {
      mcpAudit.initDb(process.env.MCP_AUDIT_DB_PATH || undefined, {
        hashKey: authConfig.serviceToken,
      });
      mcpAudit.prune();
    } catch (error) {
      process.stderr.write(`[egressview-mcp] audit store unavailable: ${error.message}\n`);
    }
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
    app.use('/mcp', createRequestContextMiddleware());
    app.use('/mcp', createRateLimitMiddleware(limiter));
    app.use('/mcp', createAuditMiddleware());
    app.use('/mcp', oauth.middleware());
    app.use('/mcp', createToolScopeMiddleware(scopeMapping, oauth));
  } else {
    if (!TOKEN) {
      process.stderr.write(
        '[egressview-mcp] WARNING: EGRESSVIEW_TOKEN is not set — API calls will fail\n'
      );
    }
    // Private token mode accepts the dedicated token in either supported header.
    app.use('/mcp', createAuthMiddleware(authConfig.token));
  }

  // Streamable HTTP — handles POST (tool calls) and GET (SSE stream)
  const handleMcp = async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const includeWriteTools = authConfig.mode !== 'oauth'
      || scopeMapping.authorizeTool('set_device_note', req.mcpAuth?.scopes).allowed;
    const server = buildMcpServer({ includeWriteTools, apiClient: internalApiClient });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
    } finally {
      res.on('close', () => server.close().catch(() => {}));
    }
  };

  app.post('/mcp',   handleMcp);
  app.get('/mcp',    handleMcp);
  app.delete('/mcp', handleMcp);

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      const actualPort = httpServer.address().port;
      process.stderr.write(`[egressview-mcp] HTTP transport listening on 127.0.0.1:${actualPort}/mcp\n`);
      process.stderr.write(`[egressview-mcp] HTTP authentication mode: ${authConfig.mode}\n`);
      process.stderr.write(`[egressview-mcp] Proxying API calls to ${BASE}\n`);
      if (authConfig.mode === 'oauth') {
        const limits = limiter.config;
        process.stderr.write(
          `[egressview-mcp] Limits: ${limits.globalPerMinute}/min global, `
          + `${limits.perSubjectPerMinute}/min subject, ${limits.perClientPerMinute}/min client, `
          + `${limits.maxConcurrent} concurrent\n`
        );
      }
      resolve(httpServer);
    });
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  if (process.env.MCP_PORT !== undefined && process.env.MCP_PORT !== '') {
    let port;
    let authConfig;
    try {
      port = resolveMcpPort(process.env.MCP_PORT);
      authConfig = resolveHttpAuthConfig();
    } catch (err) {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      process.exit(1);
    }
    startHttp(port, authConfig).catch(err => {
      process.stderr.write(`[egressview-mcp] ${err.message}\n`);
      process.exit(1);
    });
  } else {
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
