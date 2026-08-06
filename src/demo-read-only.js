'use strict';
// Demo mode write protection middleware.
//
// When DEMO_MODE=true and this middleware is active, all state-changing API
// requests (POST, PUT, PATCH, DELETE) are rejected with 403 — except the
// authentication endpoints that let visitors log in and explore the UI.
//
// This prevents public demo visitors from mutating data, changing settings,
// restoring backups, or triggering AI calls while still allowing full
// read-only exploration of every tab.

const ALLOWED_WRITE_PATHS = new Set([
  '/api/auth/login',
  '/api/admin/verify',
]);

function createDemoReadOnly() {
  return function demoReadOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    // Allow login so visitors can authenticate and browse
    const path = req.path || req.url.split('?')[0];
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
