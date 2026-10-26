const crypto = require('crypto');
const db = require('../models/database');

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

// Regenerate session secret — invalidates ALL existing tokens (logout all devices)
function resetSessionSecret() {
  const secret = crypto.randomBytes(32).toString('hex');
  db.setSetting('session_secret', secret);
  return secret;
}

// Auth middleware — protects admin routes
function requireAuth(req, res, next) {
  // Ensure default password exists
  if (!db.getAdminPassword()) {
    db.setAdminPassword('admin');
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.auth_token;

  if (token) {
    const secret = getSessionSecret();
    const payload = verifyToken(token, secret);
    // Verify role and token expiry (24 hours)
    if (payload && payload.role === 'admin' && payload.iat && (Date.now() - payload.iat) < 86400000) {
      req.isAdmin = true;
      return next();
    }
  }

  // Not authenticated — redirect to login
  res.redirect('/admin/login');
}

// Create auth cookie
function createAuthCookie(res, req) {
  const secret = getSessionSecret();
  const token = signToken({ role: 'admin', iat: Date.now() }, secret);
  const secure = req && req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400${secure}`);
}

// Clear auth cookie
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
}

// Create a short-lived 2FA pending token (5 min expiry, HttpOnly cookie)
function create2faPendingCookie(res, req) {
  const secret = getSessionSecret();
  const token = signToken({ purpose: '2fa_pending', iat: Date.now() }, secret);
  const secure = req && req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `2fa_pending=${token}; HttpOnly; Path=/admin/login; SameSite=Strict; Max-Age=300${secure}`);
}

// Verify 2FA pending token (valid for 5 minutes)
function verify2faPendingToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['2fa_pending'];
  if (!token) return false;
  const secret = getSessionSecret();
  const payload = verifyToken(token, secret);
  return payload && payload.purpose === '2fa_pending' && payload.iat && (Date.now() - payload.iat) < 300000;
}

// Clear 2FA pending cookie
function clear2faPendingCookie(res) {
  res.appendHeader('Set-Cookie', '2fa_pending=; HttpOnly; Path=/admin/login; SameSite=Strict; Max-Age=0');
}

module.exports = { requireAuth, createAuthCookie, clearAuthCookie, resetSessionSecret, create2faPendingCookie, verify2faPendingToken, clear2faPendingCookie };
