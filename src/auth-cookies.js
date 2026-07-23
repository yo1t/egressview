'use strict';

const SESSION_COOKIE = 'egressview_session';
const CSRF_COOKIE = 'egressview_csrf';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return result;
}

function cookieOptions(req, { httpOnly, maxAge, subpath = '' } = {}) {
  const secure = req.secure ||
    process.env.EGRESSVIEW_SECURE_COOKIES === 'true' ||
    /^https:\/\//i.test(process.env.EGRESSVIEW_PUBLIC_URL || '');
  return {
    httpOnly,
    secure,
    sameSite: 'lax',
    path: subpath || '/',
    maxAge,
  };
}

function setSessionCookies(req, res, session, subpath = '') {
  const maxAge = Math.max(0, session.expiresAt - Date.now());
  res.cookie(SESSION_COOKIE, session.token, cookieOptions(req, {
    httpOnly: true, maxAge, subpath,
  }));
  res.cookie(CSRF_COOKIE, session.csrfToken, cookieOptions(req, {
    httpOnly: false, maxAge, subpath,
  }));
}

function clearSessionCookies(req, res, subpath = '') {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req, { httpOnly: true, subpath }));
  res.clearCookie(CSRF_COOKIE, cookieOptions(req, { httpOnly: false, subpath }));
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

function verifyCookieCsrf(req, sessions) {
  if (!UNSAFE_METHODS.has(req.method) || req.authSource !== 'cookie') return true;
  const cookies = parseCookies(req.headers.cookie);
  const header = req.get('X-CSRF-Token') || '';
  if (!header || header !== cookies[CSRF_COOKIE]) return false;
  return sessions.verifyCsrf(req.session, header);
}

module.exports = {
  clearSessionCookies,
  cookieOptions,
  parseCookies,
  sessionToken,
  setSessionCookies,
  verifyCookieCsrf,
  CSRF_COOKIE,
  SESSION_COOKIE,
};
