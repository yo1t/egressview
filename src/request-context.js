'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');

const REQUEST_ID_HEADER = 'X-Request-Id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const requestStorage = new AsyncLocalStorage();

function normalizeRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : null;
}

function getRequestId() {
  return requestStorage.getStore()?.requestId || null;
}

function runWithRequestId(requestId, callback) {
  return requestStorage.run({ requestId }, callback);
}

function safeRequestPath(req) {
  return String(req.originalUrl || req.url || '')
    .split('?')[0]
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 512);
}

function createRequestContextMiddleware({ idFactory = randomUUID, logger = null } = {}) {
  return function requestContext(req, res, next) {
    const received = req.get?.(REQUEST_ID_HEADER) ?? req.headers?.['x-request-id'];
    const requestId = normalizeRequestId(received) || idFactory();
    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithRequestId(requestId, () => {
      const method = String(req.method || 'UNKNOWN').slice(0, 16);
      const path = safeRequestPath(req);
      logger?.debug(`[http] ${method} ${path} started`);
      res.on('finish', () => {
        const message = `[http] ${method} ${path} ${res.statusCode}`;
        if (res.statusCode >= 500) logger?.error(message);
        else if (res.statusCode === 401 || res.statusCode === 429) logger?.warn(message);
        else logger?.debug(message);
      });
      next();
    });
  };
}

module.exports = {
  REQUEST_ID_HEADER,
  createRequestContextMiddleware,
  getRequestId,
  normalizeRequestId,
  runWithRequestId,
};
