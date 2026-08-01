'use strict';

const express = require('express');
const compression = require('compression');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const authRoutes = require('./routes/auth');
const apiIdentityRoutes = require('./routes/api-identities');
const notesRoutes = require('./routes/notes');
const connectionsRoutes = require('./routes/connections');
const devicesRoutes = require('./routes/devices');
const backupRoutes = require('./routes/backup');
const configRoutes = require('./routes/config');
const slackRoutes = require('./routes/slack');
const notificationLogRoutes = require('./routes/notification-log');
const beaconsRoutes = require('./routes/beacons');
const routerRoutes = require('./routes/routers');
const manualThreatRoutes = require('./routes/manual-threat');
const aiRoutes = require('./routes/ai');
const aiNotificationRoutes = require('./routes/ai-notifications');
const { createSlowRequestLogger } = require('./slow-request-log');
const { createRequestContextMiddleware } = require('./request-context');
const { createTrustProxy } = require('./proxy-trust');
const { createGlobalRateLimit } = require('./global-rate-limit');
const i18nCatalog = require('./data/i18n.json');

function serializeI18nModule(catalog) {
  const json = JSON.stringify(catalog)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `export default ${json};\n`;
}

function createIndexHtmlBase(indexHtml, subpath, assetVersion, htmlEscape) {
  return indexHtml
    .replace(/__BASE__/g, htmlEscape(subpath))
    .replace(/__ASSET_VERSION__/g, htmlEscape(assetVersion));
}

function resolveIndexBasePath(requestPath, subpath, forwardedPrefix) {
  if (!subpath) return '';
  if (requestPath.startsWith(`${subpath}/`)) return subpath;
  return forwardedPrefix === subpath ? subpath : '';
}

function injectIndexBootstrap(indexHtmlBase, subpath, demoMode, nonce, htmlEscape) {
  const baseScript = `<script nonce="${nonce}">window.BASE_URL = '${htmlEscape(subpath)}'; window._DEMO_MODE = ${demoMode};</script>`;
  return indexHtmlBase.replace('</head>', baseScript + '\n</head>');
}

function buildCspHeader(cspNonce, tlsEnabled) {
  const parts = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${cspNonce}'`,
    "style-src 'self'",
    "style-src-elem 'self'",
    "img-src 'self' data:",
    "connect-src 'self' wss:",
    "object-src 'none'",
    "base-uri 'self'",
  ];
  return { value: parts.join('; ') + ';', hsts: tlsEnabled ? 'max-age=31536000; includeSubDomains' : null };
}

function setSecurityHeaders(req, res, tlsEnabled) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const csp = buildCspHeader(res.locals.cspNonce, tlsEnabled || req.secure);
  if (csp.hsts) res.setHeader('Strict-Transport-Security', csp.hsts);
  res.setHeader('Content-Security-Policy', csp.value);
}

function registerHealthRoutes(app, healthState) {
  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(healthState.liveness());
  });
  app.get('/readyz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ready = healthState.isReady();
    res.status(ready ? 200 : 503).json(healthState.readiness());
  });
}

function configureHttpApp(app, {
  subpath,
  assetVersion,
  demoMode,
  appRoot,
  htmlEscape,
  tlsEnabled,
  routeCtx,
  requireAdmin,
  enforceApiPermissions,
  beacons,
  appState,
  saveConfig,
  beaconScanRunner,
  logger,
  healthState,
}) {
  app.set('trust proxy', createTrustProxy());
  app.use(createRequestContextMiddleware({ logger }));
  app.use(createSlowRequestLogger());
  app.use(createGlobalRateLimit());

  app.use((req, res, next) => {
    setSecurityHeaders(req, res, tlsEnabled);
    next();
  });

  registerHealthRoutes(app, healthState);

  app.use(compression());
  app.use('/api', express.json({ limit: '64kb' }));
  app.use('/api', enforceApiPermissions);

  const indexRoutes = ['/', '/index.html'];
  if (subpath) indexRoutes.push(`${subpath}/`, `${subpath}/index.html`);

  const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  const indexHtmlBases = new Map([
    ['', createIndexHtmlBase(indexHtml, '', assetVersion, htmlEscape)],
  ]);
  if (subpath) {
    indexHtmlBases.set(subpath, createIndexHtmlBase(indexHtml, subpath, assetVersion, htmlEscape));
  }
  const i18nModule = serializeI18nModule(i18nCatalog);

  app.get(indexRoutes, (req, res) => {
    const basePath = resolveIndexBasePath(req.path, subpath, req.get('x-forwarded-prefix'));
    res.type('html').send(injectIndexBootstrap(
      indexHtmlBases.get(basePath),
      basePath,
      demoMode,
      res.locals.cspNonce,
      htmlEscape
    ));
  });

  const i18nModuleRoutes = ['/js/i18n-data.js'];
  if (subpath) i18nModuleRoutes.push(`${subpath}/js/i18n-data.js`);
  app.get(i18nModuleRoutes, (req, res) => {
    const etag = `"${assetVersion}-i18n-data.js"`;
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.type('application/javascript').send(i18nModule);
  });

  const jsModuleRoutes = ['/js/:file'];
  if (subpath) jsModuleRoutes.push(`${subpath}/js/:file`);
  app.get(jsModuleRoutes, (req, res, next) => {
    const file = req.params.file || '';
    if (!/^[A-Za-z0-9._-]+\.js$/.test(file)) return next();
    const jsDir = path.join(appRoot, 'public', 'js');
    const filePath = path.join(jsDir, file);
    if (path.resolve(filePath) !== path.join(jsDir, path.basename(file))) return next();
    fs.readFile(filePath, 'utf8', (err, js) => {
      if (err) return next();
      const replaced = js.replace(/__ASSET_VERSION__/g, htmlEscape(assetVersion));
      const etag = `"${assetVersion}-${file}"`;
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.type('application/javascript').send(replaced);
    });
  });

  const staticOptions = {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.js')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  };
  if (subpath) app.use(subpath, express.static(path.join(appRoot, 'public'), staticOptions));
  app.use(express.static(path.join(appRoot, 'public'), staticOptions));

  app.use('/api', authRoutes(routeCtx));
  if (routeCtx.apiIdentities) app.use('/api', apiIdentityRoutes(routeCtx));
  if (routeCtx.routerManager) app.use('/api', routerRoutes(routeCtx));
  app.use('/api', notesRoutes(routeCtx));
  app.use('/api', connectionsRoutes(routeCtx));
  app.use('/api', devicesRoutes(routeCtx));
  app.use('/api', backupRoutes(routeCtx));
  app.use('/api', configRoutes(routeCtx));
  app.use('/api', slackRoutes(routeCtx));
  app.use('/api', notificationLogRoutes(routeCtx));
  app.use('/api', beaconsRoutes({
    requireAdmin,
    beacons,
    appState,
    saveConfig,
    onConfigChange: () => {
      beaconScanRunner.scheduleBeaconScan();
      beaconScanRunner.runBeaconScan();
    },
  }));
  if (routeCtx.manualThreat) app.use('/api', manualThreatRoutes(routeCtx));
  if (routeCtx.aiProvider) app.use('/api', aiRoutes(routeCtx));
  if (routeCtx.aiNotificationService) app.use('/api', aiNotificationRoutes(routeCtx));

  app.use((err, req, res, next) => {
    logger.error('[express] unhandled error:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
  });
}

module.exports = {
  buildCspHeader,
  configureHttpApp,
  createIndexHtmlBase,
  injectIndexBootstrap,
  registerHealthRoutes,
  resolveIndexBasePath,
  setSecurityHeaders,
  serializeI18nModule,
};
