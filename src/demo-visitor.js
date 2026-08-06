// Anonymous visitor identity for the public read-only demo.
//
// The demo has no way to hand a visitor a credential: the local administrator
// password is generated randomly at every start and written only inside the
// container, and publishing the admin token would put a full-access credential
// on a web page. Without something here, the demo is a login screen nobody can
// pass.
//
// So the demo authenticates every caller as a fixed anonymous `viewer`. This is
// a normal session object rather than a special case in the permission
// boundary: it flows through the same role resolution, so it carries exactly
// the viewer permission set and nothing else. Writes stay blocked twice over —
// once because viewer has no write permission, and once because the demo
// read-only middleware rejects every mutating method.
//
// It is deliberately not persisted. A public demo is scanned continuously, and
// minting a session row per cookie-less request would grow the session store
// without bound.
//
// **Both DEMO_MODE and DEMO_READ_ONLY are required to enable this.** Either
// flag alone must not, because DEMO_MODE is what guarantees this is not a real
// deployment: it refuses to start under NODE_ENV=production, uses a separate
// database, and disables router collection. Enabling anonymous access on the
// strength of DEMO_READ_ONLY alone would turn a misconfigured production
// instance into an open one.
'use strict';

const crypto = require('node:crypto');
const { ROLES } = require('./roles');

// Stable across restarts and distinct from any real subject, so audit rows for
// the demo group together instead of looking like many separate identities.
const DEMO_SUBJECT_HASH = crypto
  .createHash('sha256')
  .update('egressview:demo-visitor')
  .digest('hex');

const DEMO_VISITOR_SESSION = Object.freeze({
  id: 'demo-visitor',
  authMethod: 'demo',
  role: ROLES.VIEWER,
  subjectHash: DEMO_SUBJECT_HASH,
  deviceLabel: 'demo visitor',
});

/**
 * Returns the shared visitor session when the demo is running read-only, and
 * null otherwise. Null means "no anonymous access", which is the normal case.
 */
function demoVisitorFor({ demoMode, demoReadOnly }) {
  if (demoMode !== true || demoReadOnly !== true) return null;
  return DEMO_VISITOR_SESSION;
}

module.exports = { DEMO_VISITOR_SESSION, demoVisitorFor };
