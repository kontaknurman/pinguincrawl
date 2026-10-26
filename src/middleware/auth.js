const crypto = require('crypto');
const db = require('../models/database');

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PENDING_2FA_MAX_AGE_MS = 5 * 60 * 1000;

// Generate a random secret on first run, persist in settings
function getSessionSecret() {
  let secret = db.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.setSetting('session_secret', secret);
  }
  return secret;
}

// Create HMAC-signed token from payload
function signToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verify and decode signed token
function verifyToken(token, secret) {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
}

// Parse cookie header
function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  });
  return cookies;
}

/**
 * The user a signed cookie belongs to, or null. The token carries the user id and that
 * user's session_version: a new password, "logout everywhere" or deleting the account
 * changes or removes it, which ends every session of that account (and only that one).
 */
function userFromCookie(req, name, purpose, maxAgeMs) {
  const token = parseCookies(req.headers.cookie)[name];
  if (!token) return null;
  const payload = verifyToken(token, getSessionSecret());
  if (!payload || payload.purpose !== purpose || !payload.iat || Date.now() - payload.iat >= maxAgeMs) return null;
  const user = db.getUserById(payload.uid);
  return user && user.session_version === payload.sv ? user : null;
}

// Pages a user with a default or admin-issued password may still reach
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/account/password', '/change-password']);

// Auth middleware — protects admin routes
function requireAuth(req, res, next) {
  const user = userFromCookie(req, 'auth_token', 'session', SESSION_MAX_AGE_MS);
  if (!user) return res.redirect('/admin/login');
  req.user = user; // full row, server-side only
  res.locals.currentUser = { id: user.id, username: user.username };
  if (user.must_change_password && !ALLOWED_WHILE_MUST_CHANGE.has(req.path)) {
    return res.redirect('/admin/account/password');
  }
  next();
}

// Create auth cookie
function createAuthCookie(res, req, user) {
  const token = signToken({ purpose: 'session', uid: user.id, sv: user.session_version, iat: Date.now() }, getSessionSecret());
  const secure = req && req.secure ? '; Secure' : '';
  res.appendHeader('Set-Cookie', `auth_token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400${secure}`);
}

// Clear auth cookie
function clearAuthCookie(res) {
  res.appendHeader('Set-Cookie', 'auth_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
}

// Create a short-lived 2FA pending token (5 min expiry, HttpOnly cookie) for this user
function create2faPendingCookie(res, req, user) {
  const token = signToken({ purpose: '2fa_pending', uid: user.id, sv: user.session_version, iat: Date.now() }, getSessionSecret());
  const secure = req && req.secure ? '; Secure' : '';
  res.appendHeader('Set-Cookie', `2fa_pending=${token}; HttpOnly; Path=/admin/login; SameSite=Strict; Max-Age=300${secure}`);
}

// The user whose password was accepted in the last 5 minutes, waiting for their 2FA code
function pending2faUser(req) {
  return userFromCookie(req, '2fa_pending', '2fa_pending', PENDING_2FA_MAX_AGE_MS);
}

// Clear 2FA pending cookie
function clear2faPendingCookie(res) {
  res.appendHeader('Set-Cookie', '2fa_pending=; HttpOnly; Path=/admin/login; SameSite=Strict; Max-Age=0');
}

module.exports = { requireAuth, createAuthCookie, clearAuthCookie, create2faPendingCookie, pending2faUser, clear2faPendingCookie };
