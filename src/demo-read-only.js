'use strict';

// Demo mode write protection middleware.
//
// When DEMO_READ_ONLY=true and this middleware is active, all state-changing
// API requests (POST, PUT, PATCH, DELETE) are rejected with 403 — except the
// authentication endpoints that let visitors log in and explore the UI.
//
// This is deliberately separate from DEMO_MODE: DEMO_MODE only seeds synthetic
// data and disables real router connections, and must still allow writes such
// as backup restore and MCP calls (the portability gate relies on that).
// DEMO_READ_ONLY is the flag the public Fly.io demo sets to stop visitors from
// mutating data, changing settings, restoring backups, or triggering AI calls
// while still allowing full read-only exploration of every tab.

// Mount-relative allowlist: this middleware runs under `app.use('/api', ...)`,
// so it matches against the original request path (which keeps the `/api`
// prefix) to stay correct regardless of where it is mounted.
const ALLOWED_WRITE_PATHS = new Set([
  '/api/auth/login',
  '/api/admin/verify',
]);

function createDemoReadOnly() {
  return function demoReadOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    // Use originalUrl so the check works even though the middleware is mounted
    // under '/api' (which strips the prefix from req.path).
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (ALLOWED_WRITE_PATHS.has(path)) {
      return next();
    }
    return res.status(403).json({
      error: 'demo_read_only',
      message: 'This is a read-only demo. Write operations are disabled.',
    });
  };
}

module.exports = { createDemoReadOnly };
