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

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE      = (process.env.EGRESSVIEW_URL  || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN     = process.env.EGRESSVIEW_TOKEN || '';
const MCP_PORT  = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : null;
// Auth token for the HTTP MCP endpoint; defaults to EGRESSVIEW_TOKEN
const MCP_TOKEN = process.env.MCP_TOKEN || TOKEN;

if (!TOKEN) {
  process.stderr.write('[egressview-mcp] WARNING: EGRESSVIEW_TOKEN is not set — API calls will fail\n');
}
// Guard: HTTP mode with an empty token would allow unauthenticated access
if (process.env.MCP_PORT && !MCP_TOKEN) {
  process.stderr.write('[egressview-mcp] ERROR: EGRESSVIEW_TOKEN (or MCP_TOKEN) must be set in HTTP mode\n');
  process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function api(path, params = {}) {
  const url = new URL(`${BASE}/api${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { 'X-Admin-Token': TOKEN },
  });
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`API ${path} returned non-JSON response`);
  }
}

async function apiPost(path, body = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method:  'POST',
    headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API POST ${path} returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`API POST ${path} returned non-JSON response`);
  }
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

function buildMcpServer() {
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
      const data = await api('/connections/threat-counts', { from, to });
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
      const data = await api('/connections/summary', { from, to, buckets: 1 });
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
      const data = await api('/connections/summary', { from, to, buckets: 1 });
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
      const data = await api('/connections/summary', { from, to, buckets: 1, src: src || undefined });
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
      const data = await api('/connections/new-nodes', { from, to });
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
      const data = await api('/connections/threat-connections', { from, to, confidence, limit });
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
      const data = await api('/notification-log', { from, to });
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
      const data = await api('/devices', { includeArchived: include_archived ? '1' : undefined });
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
      const data = await api('/connections', {
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
      const data = await api('/devices');
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

  // ⑪ Set device note
  registerTool(server,
    'set_device_note',
    'Sets or updates the memo note for a device identified by its source IP address. Pass an empty string to delete the note.',
    {
      src:  z.string().describe('Source IP address of the device'),
      note: z.string().max(500).describe('Memo text to save (empty string deletes the note)'),
    },
    async ({ src, note }) => {
      await apiPost('/notes', { ip: src, note });
      const trimmed = note.trim();
      return ok({ src, note: trimmed || null, deleted: !trimmed });
    }
  );

  return server;
}

// ─── stdio transport ──────────────────────────────────────────────────────────

async function startStdio() {
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

async function startHttp(port) {
  const app = express();
  app.use(express.json());

  // Auth: accept X-Admin-Token header or Authorization: Bearer <token>
  app.use('/mcp', createAuthMiddleware(MCP_TOKEN));

  // Streamable HTTP — handles POST (tool calls) and GET (SSE stream)
  const handleMcp = async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server    = buildMcpServer();
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

  app.listen(port, '127.0.0.1', () => {
    process.stderr.write(`[egressview-mcp] HTTP transport listening on 127.0.0.1:${port}/mcp\n`);
    process.stderr.write(`[egressview-mcp] Proxying API calls to ${BASE}\n`);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (require.main === module) {
  if (MCP_PORT) {
    startHttp(MCP_PORT).catch(err => {
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
