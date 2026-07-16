'use strict';

const express = require('express');
const compression = require('compression');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const authRoutes = require('./routes/auth');
const notesRoutes = require('./routes/notes');
const connectionsRoutes = require('./routes/connections');
const devicesRoutes = require('./routes/devices');
const backupRoutes = require('./routes/backup');
const configRoutes = require('./routes/config');
const slackRoutes = require('./routes/slack');
const notificationLogRoutes = require('./routes/notification-log');
const beaconsRoutes = require('./routes/beacons');
const routerRoutes = require('./routes/routers');
const { createSlowRequestLogger } = require('./slow-request-log');
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

function injectIndexBootstrap(indexHtmlBase, subpath, demoMode, nonce, htmlEscape) {
  const baseScript = `<script nonce="${nonce}">window.BASE_URL = '${htmlEscape(subpath)}'; window._DEMO_MODE = ${demoMode};</script>`;
  return indexHtmlBase.replace('</head>', baseScript + '\n</head>');
}

function buildCspHeader(cspNonce, tlsEnabled) {
  const parts = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${cspNonce}' https://d3js.org https://cdn.jsdelivr.net`,
    "style-src 'self'",
    "style-src-elem 'self'",
    "img-src 'self' data:",
    "connect-src 'self' wss: https://cdn.jsdelivr.net",
    "object-src 'none'",
    "base-uri 'self'",
  ];
  return { value: parts.join('; ') + ';', hsts: tlsEnabled ? 'max-age=31536000; includeSubDomains' : null };
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
  beacons,
  appState,
  saveConfig,
  beaconScanRunner,
  logger,
}) {
  app.use(createSlowRequestLogger());

  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const csp = buildCspHeader(res.locals.cspNonce, tlsEnabled);
    if (csp.hsts) res.setHeader('Strict-Transport-Security', csp.hsts);
    res.setHeader('Content-Security-Policy', csp.value);
    next();
  });

  app.use(compression());

  const indexRoutes = ['/', '/index.html'];
  if (subpath) indexRoutes.push(`${subpath}/`, `${subpath}/index.html`);

  const indexHtmlBase = createIndexHtmlBase(
    fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8'),
    subpath,
    assetVersion,
    htmlEscape
  );
  const i18nModule = serializeI18nModule(i18nCatalog);

  app.get(indexRoutes, (req, res) => {
    res.type('html').send(injectIndexBootstrap(
      indexHtmlBase,
      subpath,
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
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', authRoutes(routeCtx));
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
  serializeI18nModule,
};
