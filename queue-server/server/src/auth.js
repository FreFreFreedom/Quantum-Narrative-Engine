// Minimal single-user JWT auth (§10.7: requireAuth is one of only two infra dependencies
// promptQueue.js needs). QNE is single-user, so there's no user table/password hashing —
// just one shared secret (ADMIN_PASSWORD) that exchanges for a signed JWT.

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required.');
  process.exit(1);
}

export function issueToken() {
  return jwt.sign({ sub: 'antoine' }, JWT_SECRET, { expiresIn: '7d' });
}

// The web-capture extension's key (plans/web-capture.md). It lives in a browser for a
// year, so it must not be a full session: it opens only the doors capture and the
// side panel need, and every other route answers 403 to it. The WebSocket refuses it
// outright.
export function issueCaptureToken() {
  return jwt.sign({ sub: 'antoine', scope: 'capture' }, JWT_SECRET, { expiresIn: '365d' });
}
const CAPTURE_DOORS = [
  ['POST', /^\/api\/passages\/?$/],
  ['POST', /^\/api\/convos\/library\/interest-imports\/?$/],
  ['GET', /^\/api\/auth\/capture-check\/?$/],
  // The side panel: what QNE holds about the page, a question about it, the stack.
  ['GET', /^\/api\/capture\/page\/?$/],
  ['POST', /^\/api\/capture\/ask\/?$/],
  ['POST', /^\/api\/capture\/stack\/?$/],
];
function captureMayPass(req) {
  const path = String(req.originalUrl || '').split('?')[0];
  return CAPTURE_DOORS.some(([method, re]) => req.method === method && re.test(path));
}

// Shared by requireAuth (HTTP) and realtime.js (WebSocket) so both auth paths
// verify the same way — pinning algorithms is cheap defense-in-depth against a
// signature-downgrade attack, even though only HS256 is ever used to sign.
export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  let user;
  try {
    user = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (user.scope && !(user.scope === 'capture' && captureMayPass(req))) {
    return res.status(403).json({ error: 'token_scope' });
  }
  req.user = user;
  next();
}
