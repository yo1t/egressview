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
const { createMcpHandler } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { toNodeHandler } = require('@modelcontextprotocol/node');
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
const mcpAudit = require('./src/mcp-audit');
const { createTrustProxy } = require('./src/proxy-trust');
const { createMcpRateLimiter, rateLimitOptionsFromEnv } = require('./src/mcp-rate-limit');
const {
  wrapToolHandler,
  buildMcpServer: buildMcpServerBase,
} = require('./src/mcp-tools');

// Bind the default API client so callers keep the previous signature. The
// original was a default parameter, which also applied when a caller passed
// apiClient: undefined explicitly; a plain spread would instead overwrite the
// default with that undefined, so fall back after spreading rather than before.
function buildMcpServer(options = {}) {
  const merged = { ...options };
  if (merged.apiClient === undefined) merged.apiClient = defaultApiClient;
  return buildMcpServerBase(merged);
}
const {
  MCP_SERVICE_PERMISSIONS,
  createAuthMiddleware,
  createToolScopeMiddleware,
  createRequestContextMiddleware,
  createRateLimitMiddleware,
  createAuditMiddleware,
  initializeMcpAudit,
  resolveTimeoutMs,
  auditContext,
} = require('./src/mcp-http-middleware');

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


async function startHttp(
  port,
  authConfig = resolveHttpAuthConfig(),
  { bindAddress = '127.0.0.1' } = {}
) {
  const app = express();
  // Only the proxies named here may set the client address. Without this
  // Express uses the socket address, so an untrusted caller cannot forge
  // X-Forwarded-For to poison the audit trail or evade a per-source view.
  app.set('trust proxy', createTrustProxy(process.env.MCP_TRUST_PROXY));
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
    const onToolCall = event => {
      if (req.mcpToolAuditWritten) return;
      const timedOut = req.mcpTimedOut === true;
      const eventId = mcpAudit.append({
        eventType: 'mcp_tool_call',
        outcome: timedOut ? 'failure' : event.outcome,
        reason: timedOut ? 'request_timeout' : event.reason,
        toolName: event.toolName,
        mcpMethod: 'tools/call',
        httpStatus: 200,
        ...auditContext(req),
        durationMs: event.durationMs,
      });
      // A failed immediate write leaves the response-finish fallback enabled.
      if (eventId) req.mcpToolAuditWritten = true;
    };
    return buildMcpServer({ includeWriteTools, apiClient, onToolCall });
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

    // The Streamable HTTP transport sends headers as soon as it starts the SSE
    // stream, so for a streaming response the status can no longer be changed
    // to 504. The deadline still does the work that matters: it marks the
    // request for audit and releases the concurrency slot, which is what stops
    // stalled calls wedging the endpoint closed.
    const deadline = setTimeout(() => {
      req.mcpTimedOut = true;
      const toolName = req.body?.method === 'tools/call' ? req.body?.params?.name : null;
      if (toolName && !req.mcpToolAuditWritten) {
        const eventId = mcpAudit.append({
          eventType: 'mcp_tool_call',
          outcome: 'failure',
          reason: 'request_timeout',
          toolName,
          mcpMethod: 'tools/call',
          httpStatus: res.headersSent ? 200 : 504,
          ...auditContext(req),
          durationMs: Date.now() - req.mcpStartedAt,
        });
        if (eventId) req.mcpToolAuditWritten = true;
      }
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
module.exports._wrapToolHandler        = wrapToolHandler;
module.exports._resolveHttpAuthConfig = resolveHttpAuthConfig;
module.exports._resolveMcpPort        = resolveMcpPort;
module.exports._startHttp             = startHttp;
